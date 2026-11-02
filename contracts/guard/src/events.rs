// NEP-297 events, standard `kd_guard` 1.0.0 (docs/final-idea.md §11.5.9).
use near_sdk::env;
use near_sdk::serde_json::{json, Value};

pub fn emit(event: &str, data: Value) {
    let body = json!({ "standard": "kd_guard", "version": "1.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{body}"));
}
