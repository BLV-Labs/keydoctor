// Pure Guard rules (docs/final-idea.md §11.5.4, §11.5.6, §11.5.7): no storage, no promises, so every rule is
// unit-tested without a chain.
use crate::types::{Decision, GuardPolicy, RequestStatus, WhitelistEntry};

pub const DAY_NS: u64 = 86_400 * 1_000_000_000;
pub const MEMO_MAX_CHARS: usize = 200;

/// Auto when every condition holds, otherwise Pending with the full list of reasons, in spec order.
pub fn decide(p: &GuardPolicy, wl: Option<&WhitelistEntry>, spent: u128, amount: u128) -> (Decision, Vec<String>) {
    let mut reasons = vec![];
    if wl.is_none() {
        reasons.push("NOT_WHITELISTED");
    }
    if amount > p.max_per_tx.0 {
        reasons.push("OVER_PER_TX");
    }
    if let Some(cap) = wl.and_then(|w| w.max_per_tx) {
        if amount > cap.0 {
            reasons.push("OVER_RECIPIENT_LIMIT");
        }
    }
    if spent.saturating_add(amount) > p.max_per_day.0 {
        reasons.push("OVER_DAILY_LIMIT");
    }
    let decision = if reasons.is_empty() { Decision::Auto } else { Decision::Pending };
    (decision, reasons.into_iter().map(String::from).collect())
}

/// Rolling 24 h window: once `now` reaches `start + 24h` a new window starts at `now` with nothing spent.
pub fn roll_window(start: u64, spent: u128, now: u64) -> (u64, u128) {
    if now >= start.saturating_add(DAY_NS) {
        (now, 0)
    } else {
        (start, spent)
    }
}

/// 8 to 64 chars of `[A-Za-z0-9_-]`. The id goes into the proposal description, so it cannot hold spaces.
pub fn valid_request_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// At most 200 chars on one line, so the description stays one parseable line.
pub fn clean_memo(memo: &str) -> String {
    memo.chars().take(MEMO_MAX_CHARS).map(|c| if c.is_control() { ' ' } else { c }).collect()
}

/// §11.5.6. `memo` is last: readers must take the other fields from before ` memo=`.
pub fn description(request_id: &str, agent: &str, decision: Decision, reasons: &[String], memo: &str) -> String {
    let decision = match decision {
        Decision::Auto => "auto",
        Decision::Pending => "pending",
    };
    let reasons = if reasons.is_empty() { "-".to_string() } else { reasons.join(",") };
    format!("[KD-GUARD] request={request_id} agent={agent} decision={decision} reasons={reasons} memo={memo}")
}

/// Final request status for a Sputnik proposal status, or `None` while it is still open.
/// Sputnik only writes `Expired` when someone acts on the proposal, so an `InProgress` proposal past its
/// period counts as expired here: no vote can pass it any more.
pub fn final_status(dao_status: &str, submission_time: u64, period: u64, now: u64) -> Option<RequestStatus> {
    match dao_status {
        "Approved" => Some(RequestStatus::Executed),
        "Rejected" | "Removed" => Some(RequestStatus::Rejected),
        "Expired" => Some(RequestStatus::Expired),
        "Failed" | "Moved" => Some(RequestStatus::Failed),
        "InProgress" if period > 0 && now >= submission_time.saturating_add(period) => Some(RequestStatus::Expired),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::json_types::U128;

    const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

    fn policy() -> GuardPolicy {
        GuardPolicy {
            max_per_tx: U128(5 * NEAR),
            max_per_day: U128(20 * NEAR),
            max_pending_per_agent: 3,
            min_reserve: U128(NEAR / 2),
        }
    }

    fn listed(cap: Option<u128>) -> WhitelistEntry {
        WhitelistEntry { label: "vendor".into(), max_per_tx: cap.map(U128) }
    }

    fn reasons(wl: Option<&WhitelistEntry>, spent: u128, amount: u128) -> Vec<String> {
        decide(&policy(), wl, spent, amount).1
    }

    #[test]
    fn within_every_limit_is_auto() {
        // The happy path: the Guard pays without a human only when all four conditions hold.
        assert_eq!(decide(&policy(), Some(&listed(None)), 0, 5 * NEAR), (Decision::Auto, vec![]));
    }

    #[test]
    fn each_reason_alone_makes_it_pending() {
        // Removing any one check would let that kind of request through without the council.
        assert_eq!(reasons(None, 0, NEAR), ["NOT_WHITELISTED"]);
        assert_eq!(reasons(Some(&listed(None)), 0, 5 * NEAR + 1), ["OVER_PER_TX"]);
        assert_eq!(reasons(Some(&listed(Some(NEAR))), 0, NEAR + 1), ["OVER_RECIPIENT_LIMIT"]);
        assert_eq!(reasons(Some(&listed(None)), 16 * NEAR, 4 * NEAR + 1), ["OVER_DAILY_LIMIT"]);
        let (decision, _) = decide(&policy(), None, 0, NEAR);
        assert_eq!(decision, Decision::Pending);
    }

    #[test]
    fn combined_reasons_are_all_listed_in_spec_order() {
        // The council reads every broken rule, not just the first (§11.5.4).
        assert_eq!(reasons(None, 0, 500 * NEAR), ["NOT_WHITELISTED", "OVER_PER_TX", "OVER_DAILY_LIMIT"]);
        assert_eq!(
            reasons(Some(&listed(Some(NEAR))), 19 * NEAR, 6 * NEAR),
            ["OVER_PER_TX", "OVER_RECIPIENT_LIMIT", "OVER_DAILY_LIMIT"]
        );
    }

    #[test]
    fn daily_limit_is_inclusive_and_cannot_overflow() {
        // Spending exactly the daily cap is allowed; a huge amount must not wrap past the check.
        assert_eq!(reasons(Some(&listed(None)), 15 * NEAR, 5 * NEAR), Vec::<String>::new());
        assert!(reasons(Some(&listed(None)), 10 * NEAR, u128::MAX).contains(&"OVER_DAILY_LIMIT".to_string()));
    }

    #[test]
    fn window_resets_at_exactly_24_hours() {
        // One nanosecond early keeps the spent amount; at the boundary the window starts over.
        assert_eq!(roll_window(1_000, 7, 1_000 + DAY_NS - 1), (1_000, 7));
        assert_eq!(roll_window(1_000, 7, 1_000 + DAY_NS), (1_000 + DAY_NS, 0));
    }

    #[test]
    fn request_id_length_and_charset() {
        // 8 and 64 are the inclusive bounds; a space would break the description format.
        assert!(valid_request_id(&"a".repeat(8)));
        assert!(valid_request_id(&"a".repeat(64)));
        assert!(!valid_request_id(&"a".repeat(7)));
        assert!(!valid_request_id(&"a".repeat(65)));
        assert!(valid_request_id("7c1e9f2a-0b5d-4a51-9a1e-2f3c4d5e6f70"));
        assert!(!valid_request_id("abcd efgh"));
    }

    #[test]
    fn memo_is_one_line_of_at_most_200_chars() {
        // A newline in the memo could fake a second description line for a human reader.
        assert_eq!(clean_memo("pay\ninvoice\t4"), "pay invoice 4");
        assert_eq!(clean_memo(&"é".repeat(250)).chars().count(), 200);
    }

    #[test]
    fn description_matches_the_fixed_format() {
        // checkProposals (GĐ20) parses this line; changing it breaks the Telegram alert.
        let r = vec!["NOT_WHITELISTED".to_string(), "OVER_DAILY_LIMIT".to_string()];
        assert_eq!(
            description("req-0001", "agent.testnet", Decision::Pending, &r, "invoice 4"),
            "[KD-GUARD] request=req-0001 agent=agent.testnet decision=pending reasons=NOT_WHITELISTED,OVER_DAILY_LIMIT memo=invoice 4"
        );
        assert_eq!(
            description("req-0001", "agent.testnet", Decision::Auto, &[], ""),
            "[KD-GUARD] request=req-0001 agent=agent.testnet decision=auto reasons=- memo="
        );
    }

    #[test]
    fn dao_statuses_map_to_final_request_statuses() {
        assert_eq!(final_status("Approved", 0, 10, 5), Some(RequestStatus::Executed));
        assert_eq!(final_status("Rejected", 0, 10, 5), Some(RequestStatus::Rejected));
        assert_eq!(final_status("Removed", 0, 10, 5), Some(RequestStatus::Rejected));
        assert_eq!(final_status("Expired", 0, 10, 5), Some(RequestStatus::Expired));
        assert_eq!(final_status("Failed", 0, 10, 5), Some(RequestStatus::Failed));
        assert_eq!(final_status("InProgress", 0, 10, 9), None);
    }

    #[test]
    fn in_progress_past_its_period_is_expired() {
        // Otherwise an ignored proposal holds the agent's pending slot forever.
        assert_eq!(final_status("InProgress", 100, 10, 110), Some(RequestStatus::Expired));
        assert_eq!(final_status("InProgress", 100, 0, u64::MAX), None, "unknown period: never guess expiry");
    }
}
