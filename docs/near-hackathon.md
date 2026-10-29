# NEAR HACKATHON "Build Beyond Boundaries": thông tin và yêu cầu

| | |
|---|---|
| Nguồn | Trang chính thức https://nearhackathon.com và file luật https://nearhackathon.com/HACKATHON.md (đọc ngày 2026-10-29) |
| Lưu ý | Ban tổ chức ghi rõ ngày và luật có thể thay đổi. **Đọc lại bản HACKATHON.md trực tiếp trước khi nộp** |
| Dự án của team | Key Doctor (xem `final-idea.md`, `usecase.md`) |

---

## 1. Tóm tắt nhanh

- **Chủ đề:** "Programmable money". Khẩu hiệu: thanh toán tự động, agent thông minh, tiền có trí tuệ.
- **Không cần đăng ký trước.** Chỉ có một form nộp bài cuối cùng.
- **Nộp gì:** repo GitHub public + một bài demo công khai trên X (ghi rõ "built at NEAR HACKATHON", kèm video hoặc ảnh chụp) + điền form.
- **Một dự án nộp một lần. Không sửa được sau khi nộp.**
- **Tổng giải:** 250.000 USD, trả bằng NEAR.
- **Sàng lọc:** Claude Code và Codex kiểm tra trước mọi dự án; **giám khảo người quyết định**.

---

## 2. Mốc thời gian (UTC)

| Mốc | Thời gian UTC | Giờ Việt Nam |
|---|---|---|
| Công bố (code từ mốc này được tính) | 2026-10-19 | |
| Bắt đầu, mở nộp bài | 2026-11-01 00:00 | 01/11 07:00 |
| **Hạn chót phát triển và nộp bài** | **2026-11-14 23:59** | **15/11 06:59** |
| Bắt đầu chấm | 2026-11-16 00:00 | |
| Công bố kết quả | trước 2026-11-18 23:59 | |
| Trả thưởng | Một lần, không vesting, trong 30 ngày sau kết quả | |

Ngoài khung 01/11 đến 14/11, API nộp bài trả lỗi 403.

---

## 3. Giải thưởng

| Giải | Số tiền | Số lượng | Tổng |
|---|---|---|---|
| Grand prize (toàn cuộc thi) | 55.000 USD | 1 | 55.000 USD |
| Nhất mỗi track | 10.000 USD | 13 | 130.000 USD |
| Nhì mỗi track | 3.000 USD | 13 | 39.000 USD |
| Ba mỗi track | 2.000 USD | 13 | 26.000 USD |

Số tiền cố định theo USD, trả bằng NEAR vào account ghi trong form.

---

## 4. Cách chấm

1. **Claude Code và Codex sàng lọc mọi dự án:** kiểm dự án có chạy được không và có làm đúng những gì README nói không, ra báo cáo có cấu trúc và điểm sơ bộ.
2. **Giám khảo người quyết định.** Điểm AI thấp không tự loại được dự án.
3. Không công bố tiêu chí chính thức. Các hackathon NEAR trước chấm theo: **kỹ thuật, thiết kế, tác động, độc đáo, tính bền vững**. Ban tổ chức gợi ý dùng năm tiêu chí này để chuẩn bị.

**Giám khảo:** Illia Polosukhin (NEAR), Eddy Lazzarin (a16z crypto), Mert Mumtaz (Helius), Avichal Garg (Electric Capital), Kain Warwick (Synthetix & Infinex), Haseeb Qureshi (Dragonfly), Stepan Gershuni (cyber.Fund), Claude Code & Codex.

**Yêu cầu README:** viết cho cả máy và người đọc: sản phẩm là gì, giải quyết vấn đề gì, cách thử theo các bước "làm X, thấy Y" mà giám khảo làm theo được. **Không viết kiểu quảng cáo.**

---

## 5. Thông tin phải nộp

| Trường | Quy định |
|---|---|
| Tên dự án | 2 đến 80 ký tự |
| Tên trưởng nhóm | 2 đến 80 ký tự |
| Email | Hợp lệ, tối đa 160 ký tự; mỗi email tối đa 2 bài |
| Quy mô team | Một trong: `1`, `2 - 4`, `4 - 6`, `6 - 8`, `8+` |
| **Tracks** | **Một hoặc nhiều** id (mục 7), chọn mọi track dự án phù hợp. Vẫn là một bài |
| Account NEAR nhận thưởng | Mainnet, account có tên (`team.near`) hoặc implicit 64 ký tự. Team tự tạo |
| Link repo | Public; **mỗi repo chỉ nộp được một lần** |
| Link bài demo trên X | Public, ghi "built at NEAR HACKATHON", kèm video hoặc ảnh chụp |
| Mô tả "What did you build?" | 20 đến 2.000 ký tự: vấn đề, sản phẩm, NEAR nằm ở đâu |
| Đồng ý điều khoản liên hệ | Bắt buộc |

**Ô "Website" trong form là bẫy chống spam: để trống.**

Nộp qua form tại https://nearhackathon.com/#apply, hoặc qua API `POST https://nearhackathon.com/api/applications` (chi tiết trong HACKATHON.md). Nếu nhờ coding agent nộp, agent phải in toàn bộ payload để người duyệt trước khi gửi.

---

## 6. Luật (tóm tắt Q-001 đến Q-017)

| Mã | Câu hỏi | Trả lời |
|---|---|---|
| Q-001 | Code viết trước 01/11 có được tính? | **Có, tính từ ngày công bố 19/10.** Commit trước đó là nền |
| Q-002 | Sản phẩm đã có trên chain khác? | Được. Chỉ phần tích hợp NEAR làm trong khung thời gian được chấm. Ghi rõ trong README |
| Q-003 | Bắt buộc repo mới? | Không. Dùng nhánh riêng, hoặc tag `pre-hackathon` và `hackathon-submission`, kèm mục README dẫn tới phần diff |
| Q-004 | Dự án cũ, hoặc tính năng mới trên dự án cũ? | Dự án cũ giữ nguyên: không. Tính năng mới làm trong khung thời gian: được, nếu tách theo Q-003 |
| Q-005 | Thư viện, template, code AI viết? | Đều được, kể cả thư viện tự viết trước đó. Liệt kê trong README; thư viện cũ tính là nền |
| Q-006 | 1Click JWT? | Không bắt buộc (không có thì phí 0,2%) |
| Q-007 | Testnet cho Intents? | Không có. Dùng mainnet, account dev riêng, số tiền nhỏ |
| Q-008 | Tiền thử nghiệm? | NEAR testnet miễn phí (faucet). Chi phí mainnet không được hoàn |
| Q-009 | RPC, hosting? | RPC công khai miễn phí |
| **Q-010** | **Dự án chỉ chạy testnet có hợp lệ?** | **Có, mọi track.** Chỉ dùng mainnet khi tích hợp bắt buộc mainnet |
| Q-011 | Tích hợp bắt buộc? | Không. Gợi ý của track chỉ là gợi ý |
| **Q-012** | **Demo chỉ chạy local được không?** | Được, nếu repo public, README tái lập được, bài X có **video** (ảnh chụp không đủ khi giám khảo không mở được demo). **Demo có host là điểm cộng; giữ chạy đến 18/11, tốt nhất đến 25/11** |
| Q-013 | Ban tổ chức có quyền với code? | Không. Team giữ toàn quyền; ban tổ chức được dùng tên, ảnh, video, link để quảng bá |
| **Q-014** | **Giấy phép?** | Tùy chọn, MIT được. **Thêm file LICENSE**; repo public suốt thời gian chấm |
| Q-015 | Một người nhiều dự án? | Tối đa 2 dự án độc lập; README mỗi dự án phải nêu tên dự án kia |
| Q-016 | Trả thưởng? | Một lần, trong 30 ngày |
| Q-017 | Vai trò Claude Code và Codex? | Sàng lọc: kiểm tái lập, kiểm tính năng, báo cáo, điểm sơ bộ. Người quyết định |

**Agent không được làm khi chưa có xác nhận của người:** gửi bài nộp, đăng bài lên X, public repo hoặc push, ký giao dịch, deploy mainnet, commit bí mật.

---

## 7. Mười ba track

| id | Track | Nội dung | Gợi ý nên dùng |
|---|---|---|---|
| `defi` | Unstoppable DeFi | Sàn, perps, cho vay, vault, trading agent thanh toán xuyên chuỗi qua NEAR Intents | Trading, NEAR Intents, Chain Signatures |
| `thesis` | Investment Thesis | Luận điểm đầu tư dài hạn cho NEAR, có dữ liệu on-chain, dashboard, mô hình chạy lại được. Chấm theo bằng chứng | Dữ liệu on-chain, dashboard, nghiên cứu |
| `privacy` | Privacy & Private AI | Tính toán bí mật, tài chính riêng tư, AI bảo vệ dữ liệu nhạy cảm | Private AI, TEE, NEAR AI Cloud |
| `business` | Autonomous Business | Doanh nghiệp vận hành bằng AI: quỹ, bán hàng, mua sắm, thanh toán, chia doanh thu | AI agent, NEAR Intents, Chain Signatures |
| `swarms` | AI Swarms | Thị trường phối hợp, đấu giá, mua chung, kinh tế giữa các agent | Multi-agent, NEAR Intents, sub-account |
| `security` | AI Security & Defense | Hạn mức chi tiêu, policy engine, ví sandbox, uy tín, phát hiện lừa đảo. Cho AI tiền mà không đưa hết chìa khóa | Agent security, **function-call key**, TEE attestation |
| `agents` | Agent Economy | Agent kiếm tiền, chi tiền, đàm phán, thuê agent khác, trả phí API | Agent commerce, NEAR Intents, Chain Signatures |
| `realworld` | Real-World Money | Trả lương, hóa đơn, chuyển tiền, thanh toán merchant, stablecoin cho doanh nghiệp thật | Stablecoin, NEAR Intents, meta transaction |
| `games` | Games With Real Economies | NPC có ví, chợ của người chơi, kinh tế tự tiến hóa | Agent NPC, social login, NEAR Intents, NEP-245 |
| `nfts` | NFTs That Do Something | NFT như account: giữ tiền, nhận royalty, mang quyền truy cập | Dynamic NFT, NEP-171, sub-account |
| `memecoins` | Memecoins With Mechanics | Memecoin có cơ chế: nguồn cung phản ứng cộng đồng, quỹ có luật | Memecoin, cơ chế token, NEP-141 |
| `social` | Social Money | Ngân sách chung, thưởng lập trình được, sở hữu tập thể, quyền truy cập theo uy tín **trên Sputnik DAO và Trezu**. **Đừng làm lại multisig, hãy xây thứ cộng đồng làm với nó** | **Sputnik DAO, Trezu**, named account |
| `open` | Open Innovation | Ý tưởng không vừa track nào | Thử nghiệm, chain abstraction |

Gợi ý chỉ là mong muốn của ban tổ chức, không bắt buộc. Nên nêu trong README những gợi ý dự án có dùng.

Repo `nearai/near-hackathon-prompt-examples` có sẵn prompt khởi động cho từng track.

---

## 8. Hệ sinh thái đối tác

| Đối tác | Là gì | Liên quan Key Doctor |
|---|---|---|
| **SputnikDAO** | Hạ tầng DAO | **Trực tiếp**: đọc policy, đề xuất, phiếu |
| **Trezu** | Multisig treasury cho team Web3 | **Trực tiếp**: khách hàng mục tiêu; nêu tương thích trong README |
| NEAR.AI | Private AI | Đã cân nhắc, không dùng |
| OutLayer | Giao dịch an toàn cho AI agent | Có thể nhắc trong Roadmap (Agent Guard) |
| NEAR Intents, Aurora, HOT, Rhea, meme.cooking, HEX, SVRN, GoMining | Các mảng khác | Không liên quan |

---

## 9. Áp dụng cho Key Doctor

### 9.1 Những câu hỏi mở đã có câu trả lời

| Câu hỏi mở trong `final-idea.md` | Trả lời từ luật |
|---|---|
| Q6: chọn một hay nhiều track? | **Nhiều track được** (vẫn một bài). Đề xuất: `social` + `security` |
| Code viết trước 01/11 có tính không? | Có, từ 19/10 (Q-001). Prototype và task hello làm sau 19/10 đều tính |
| Chỉ chạy testnet có được không? | Được (Q-010) |
| Dữ liệu và script chuẩn bị trước | Được, liệt kê trong README (Q-005) |

### 9.2 Chọn track

- **`social` (chính):** gợi ý track nêu đích danh Sputnik DAO và Trezu, và dặn "đừng làm lại multisig, hãy xây thứ cộng đồng làm với nó". Key Doctor không làm lại multisig mà bảo vệ quyết định của council trên multisig có sẵn.
- **`security` (phụ):** gợi ý track nêu đích danh **function-call key**, scam detection, policy engine. Rule `FC_DAO_VOTE`, `FC_ANY_METHOD`, canh khóa mới gần lúc bỏ phiếu khớp trực tiếp.
- Không chọn `privacy` (đã bỏ phần AI), `thesis` (sản phẩm không phải luận điểm đầu tư, dù có dữ liệu).

Lưu ý: luật không nói chọn nhiều track có làm tăng cơ hội giải hay không; chọn đúng các track thật sự khớp.

### 9.3 Danh sách việc bắt buộc trước khi nộp

- [ ] Repo **public** trước 14/11 23:59 UTC; **file LICENSE** (MIT).
- [ ] README cho máy đọc: sản phẩm là gì, vấn đề gì, các bước "làm X, thấy Y", không quảng cáo.
- [ ] README liệt kê thư viện, template, code do AI viết, dữ liệu chuẩn bị trước (Q-005).
- [ ] README nêu các gợi ý track đã dùng: Sputnik DAO, Trezu, function-call key.
- [ ] **Video demo** (không chỉ ảnh chụp, Q-012).
- [ ] **Demo có host** (dashboard trên Pages, Worker, bot) giữ chạy đến **18/11, tốt nhất đến 25/11**.
- [ ] Bài X ghi "built at NEAR HACKATHON", kèm video.
- [ ] Account NEAR mainnet nhận thưởng, do team tự tạo.
- [ ] Mô tả 20 đến 2.000 ký tự: vấn đề, sản phẩm, NEAR ở đâu.
- [ ] Tracks: `social`, `security`.
- [ ] Ô "Website" để trống.
- [ ] Nộp **một lần**, sau khi repo đã public và bài X đã đăng.

### 9.4 Lời khuyên rút từ luật

- **Giám khảo AI kiểm "chạy được và đúng như README".** Mọi tính năng ghi trong README phải chạy thật; tính năng chưa xong thì để mục Roadmap, không ghi như đã có.
- **Đưa HACKATHON.md cho Claude Code** của team đọc ngay từ đầu, để nó biết luật và các bước nộp.
- **Không nộp sớm khi chưa xong:** không sửa được, và mỗi repo chỉ nộp được một lần.
