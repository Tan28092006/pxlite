# Spec: pxlite: giảm chi phí cache — V1

Trạng thái: đã duyệt (2026-11-18, user)
Cập nhật: 2026-11-18
Phạm vi code: overlay/dist/core, scripts, *.mjs

## Mục tiêu

pxlite là proxy mà người dùng chạy cho Claude Code, OpenCode và Codex để chuyển ngữ cảnh thành ảnh và giảm token.
Log 600 request Claude gần nhất cho thấy chi phí nằm ở đọc cache (khoảng 53 %), ghi cache (khoảng 29 %) và output (khoảng 17 %), tính theo hệ số giá.
Spec này giảm hai khoản cache. Cách làm: ghi đủ thông tin vào log để quy được chi phí về đúng nguyên nhân, sửa việc ảnh lịch sử giống hệt bị ghi lại, và bỏ trùng các khối bị chèn lặp lại.
Cache 1 giờ chỉ được bật khi số đo sau T1 cho thấy có lời.
Không được đổi điều model nhìn thấy theo cách làm mất thông tin, và không được để request bị máy chủ từ chối.

## Output cuối

| ID | Điều kiện phải đúng | Cách kiểm |
|---|---|---|
| DONE1 | Mỗi dòng request Claude trong `~/.pxpipe/events.jsonl` có `session_id` (mã phiên Claude Code), `agent_role` (`main`, `subagent` hoặc `unknown`) và `body_kind` (`full` hoặc `delta`) | `npm test` → test mới về ba trường pass; sau khi user khởi động lại pxlite, `node scripts/cost-report.mjs --last 200` → cột `session` không rỗng ở ≥ 95 % dòng |
| DONE2 | Có báo cáo chi phí theo `body_kind`, theo phiên và theo nguyên nhân ghi cache, và nguyên nhân của `no_closed_prefix` được ghi lại kèm số liệu | `node scripts/cost-report.mjs --last 600` → in bảng tỷ trọng; mục `## Quyết định` có dòng kết luận về `no_closed_prefix` |
| DONE3 | Hai request nén liên tiếp có cùng `history_image_sha8` trong vòng 5 phút: request sau đọc được phần ảnh lịch sử từ cache thay vì ghi lại | `npm test` → test vị trí dấu cache pass (tổng dấu ≤ 4); log thật sau khởi động lại: `node scripts/cost-report.mjs --pairs` → các cặp như trên có `cache_read_tokens(sau) ≥ cache_read_tokens(trước) + 0,8 × cache_create_tokens(trước)` |
| DONE4 | Đã quyết định về cache 1 giờ dựa trên ≥ 1 ngày log có `session_id`. Nếu bật thì `ttl: "1h"` chỉ nằm trên dấu của phần đầu ổn định | `node scripts/cost-report.mjs --ttl-sim` → in chi phí 5 phút và 1 giờ; nếu bật: `npm test` → test `ttl` pass |
| DONE5 | Một khối được chèn lặp nguyên văn (ví dụ `<browser_instruction>…</browser_instruction>`) chỉ giữ bản đầu trong mỗi phiên, các bản sau thay bằng một dòng đánh dấu; câu người dùng gõ kèm theo giữ nguyên | `npm test` → test bỏ trùng pass, kể cả trường hợp body đầy đủ và body chỉ có phần mới |
| DONE6 | Không có hồi quy: toàn bộ test cũ vẫn xanh, recall vẫn chạy, overlay khớp manifest, không có request 400 do thay đổi | `npm test` → 0 fail; sha256 trong `overlay/manifest.json` khớp file overlay; log sau khởi động lại không có `status` 400 mới liên quan `cache_control` |

## Phạm vi

Trong phạm vi:

- Ghi thêm trường vào events log (tracker / transform trong `overlay/dist/core`).
- Script báo cáo `scripts/cost-report.mjs`.
- Vị trí và TTL của dấu `cache_control` mà proxy đặt quanh ảnh lịch sử.
- Bỏ trùng khối chèn lặp trong request Claude (`/v1/messages`).

Ngoài phạm vi (để sau):

- Cắt lịch sử giữa vòng tool. Số liệu cho thấy `no_closed_prefix` đến từ body chỉ có phần mới, không phải vòng tool dài (xem `## Quyết định`), nên việc này không còn lợi ích.
- Buộc Claude Code gửi body đầy đủ thay vì chỉ phần mới. Đó là hành vi của client, proxy không điều khiển được.
- Đường OpenAI / Responses (OpenCode, Codex).
- Mục 5 (tắt MCP server, giảm effort) là việc của người dùng.

## Ranh giới

- Luôn làm: chạy `npm test` với vendor junction sau mỗi thay đổi; đồng bộ file overlay sang `~/.pxpipe-lite` và cập nhật `overlay/manifest.json` cùng `patches/pxlite-vendor.patch`; chạy qa-core sau mỗi task; không ghi nội dung prompt vào log, chỉ ghi id, hash và số.
- Hỏi trước: khi cần user khởi động lại pxlite để đo log thật; khi bật cache 1 giờ; khi đổi hành vi mặc định mà người dùng nhìn thấy được.
- Không bao giờ: tự `pxlite stop` hoặc restart proxy, vì nó đang chở chính phiên làm việc này; push hoặc mở PR; sửa trực tiếp `vendor/` trong repo, vì overlay là nguồn; ghi lại hoặc xoá log cũ của người dùng.

## Ràng buộc kỹ thuật

- Stack: Node.js ESM (`.mjs`), proxy pxpipe-proxy 0.16.0 đã build sẵn (`dist/`), vá bằng overlay file JS.
- Lệnh:
  - Không có bước build.
  - Test chạy bằng PowerShell: `New-Item -ItemType Junction -Path C:\Users\acer\pxlite\vendor -Target C:\Users\acer\.pxpipe-lite\vendor; npm test; cmd /c rmdir C:\Users\acer\pxlite\vendor`.
  - Lint: không có.
- Cấu trúc và quy ước:
  - Repo không có `AGENTS.md` / `CLAUDE.md`. Quy ước nằm ở `README.md` và `patches/README.md`.
  - File overlay phải được ghi trong `overlay/manifest.json` (sha256) và `patches/pxlite-vendor.patch`.
  - Mã phiên lấy theo cách `recall-session.mjs` đang làm: header `x-claude-code-session-id`, nếu thiếu thì `metadata.user_id` → `session_id`.
- Giao hàng:
  - Nhánh `main` của repo cục bộ `C:\Users\acer\pxlite`.
  - Commit cục bộ sau mỗi task đã QA pass: có, không có dòng attribution.
  - Push và PR: chỉ khi user bảo.

## Giả định

- [đã xác nhận] pxlite nạp `dist/core/*.js` trực tiếp nên overlay có hiệu lực — nguồn: `pxlite.mjs:307`.
- [đã xác nhận] `no_closed_prefix` (542/600) là các body chỉ có phần mới: trung vị khoảng 1.340 ký tự text, 0 ảnh, không có system, trong khi đọc cache tăng đúng bằng phần mới — nguồn: phân tích `events.jsonl` ngày 2026-11-18; chú thích upstream `transform.js:1444` ("server-side thread continuations whose body is only the delta").
- [đã xác nhận] `first_user_sha8` không phân biệt được phiên: `f3ca9620` xuất hiện từ 2026-11-16 đến 2026-11-18 — nguồn: cùng phân tích.
- [đã xác nhận] Ảnh lịch sử giống hệt vẫn bị ghi lại, và lần đọc chỉ trúng 12.580 token phần system. Ví dụ `faea0462` lúc 06:32:11, 06:32:22, 06:32:53 ngày 2026-11-18 ghi lần lượt 72.826, 72.854, 80.031 token — nguồn: cùng phân tích.
- [đã xác nhận] (default được user duyệt 2026-11-18) Lý do ảnh giống hệt vẫn bị ghi lại là dấu `cache_control` nằm sau ảnh lịch sử quá 20 khối, vượt quá tầm dò ngược của máy chủ — default đề xuất: T3 kiểm chứng trên body thật trước khi sửa.
- [đã xác nhận] (default được user duyệt 2026-11-18) Cách nhận biết subagent từ request — default đề xuất: T1 dò từ header và system prompt; không chắc thì ghi `unknown`, không đoán.
- [đã xác nhận] (default được user duyệt 2026-11-18) Người dùng có mở phiên mới trong vòng 1 giờ với phần đầu giống hệt hay không (cơ sở cho cache 1 giờ) — default đề xuất: đo ở T4, chỉ bật khi tính ra có lời.

## Câu hỏi mở

- (không có)

## Quyết định

- 2026-11-18 — Bỏ hướng "cắt giữa vòng tool" — `no_closed_prefix` là body chỉ có phần mới, lịch sử nằm phía máy chủ nên proxy không thấy để cắt — trung vị text 1.340 ký tự, đọc cache tăng đúng bằng phần mới qua từng request, xem chuỗi request 08:09–08:17 ngày 2026-11-18 trong `events.jsonl`.
- 2026-11-18 — Duyệt spec V1; giới hạn lượt chạy: T1, T2, T3, T5 liền; T4 và T6 chờ ≥ 1 ngày log sau khi user khởi động lại pxlite — user trả lời "duyệt, chạy T1 T2 T3 T5 liền".
- 2026-11-18 — Sửa công thức DONE3 thành `read(sau) ≥ read(trước) + 0,8 × create(trước)` — công thức cũ trừ cố định 12.580 nên đánh sai cặp mà request trước đọc 0 (phần system nằm trong phần ghi) — `cost-report --pairs`, cặp 06:26:32 ngày 2026-11-18: create(trước) 42.833, read(sau) 42.833.
- 2026-11-18 — Giả thuyết T3 "ghi lại có hệ thống vì dấu quá xa" yếu đi: trên log cũ 13/16 cặp cùng ảnh lịch sử đã đọc lại được; chỉ 05:51:42, 06:32:22, 06:32:53 ghi lại — `cost-report --pairs`. T3 giữ AC1 (chẩn đoán trước), AC2 chỉ sửa nếu chẩn đoán xác nhận nguyên nhân.
