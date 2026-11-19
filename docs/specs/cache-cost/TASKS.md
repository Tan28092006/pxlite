# Tasks: pxlite: giảm chi phí cache

## T1 — Ghi mã phiên, vai trò và loại body vào events log

- Lane: leaf
- Phụ thuộc: -
- Phục vụ: DONE1, DONE6
- AC1: Request Claude có header `x-claude-code-session-id` hoặc `metadata.user_id.session_id` → dòng log có `session_id` đúng giá trị đó
- AC2: `body_kind` là `delta` khi body không có system và tools, ngược lại là `full`
- AC3: `agent_role` là `main`, `subagent` hoặc `unknown`; luật nhận biết ghi trong test, không đoán khi không chắc
- AC4: Không ghi nội dung prompt nào vào log
- Verify: `npm test` → 0 fail, có test mới cho ba trường
- File dự kiến: overlay/dist/core/tracker.js, overlay/dist/core/transform.js hoặc pxlite.mjs, test.mjs, overlay/manifest.json
- Consumer: T2 (`scripts/cost-report.mjs`), người dùng đọc log
- Stub được phép: không

## T2 — Script báo cáo chi phí cache

- Lane: leaf
- Phụ thuộc: T1
- Phục vụ: DONE2
- AC1: `node scripts/cost-report.mjs --last N` in tỷ trọng chi phí (đọc, ghi, output, không cache) theo `body_kind` và theo `session_id`
- AC2: Liệt kê các lần ghi cache lớn kèm trường cache-prefix đã đổi so với request trước của cùng phiên
- AC3: Chạy được trên log cũ thiếu trường mới, nhóm các dòng đó vào `unknown`
- Verify: `node scripts/cost-report.mjs --last 600` → in bảng, không lỗi; `npm test` → test với log mẫu pass
- File dự kiến: scripts/cost-report.mjs, test.mjs
- Consumer: người dùng; T4 dùng để mô phỏng TTL
- Stub được phép: không

## T3 — Đặt dấu cache để ảnh lịch sử giống hệt được đọc lại

- Lane: trunk
- Phụ thuộc: T1
- Phục vụ: DONE3, DONE6
- AC1: Ghi chẩn đoán bằng body thật (chỉ cấu trúc, không nội dung): vị trí các dấu `cache_control`, số khối giữa ảnh lịch sử và dấu cuối
- AC2: Nếu chẩn đoán đúng là vượt tầm dò ngược: khối ảnh lịch sử cuối mang một dấu, tổng dấu trong request ≤ 4, các dấu của client không bị mất trừ khi phải nhường chỗ (ghi rõ bỏ dấu nào)
- AC3: Request không nén giữ nguyên byte
- Verify: `npm test` → test vị trí dấu và giới hạn 4 dấu pass; sau khi user khởi động lại: `node scripts/cost-report.mjs --pairs` → cặp cùng `history_image_sha8` đạt điều kiện DONE3
- File dự kiến: overlay/dist/core/transform.js, overlay/dist/core/history.js, test.mjs, overlay/manifest.json, patches/pxlite-vendor.patch
- Consumer: Anthropic Messages API (cache prompt)
- Stub được phép: không

## T5 — Bỏ trùng khối chèn lặp

- Lane: leaf
- Phụ thuộc: T1
- Phục vụ: DONE5, DONE6
- AC1: Trong body đầy đủ, khối lặp nguyên văn sau bản đầu được thay bằng một dòng đánh dấu nêu tên khối
- AC2: Trong body chỉ có phần mới, khối đã thấy ở cùng `session_id` được thay; phiên khác hoặc không có `session_id` thì không đụng
- AC3: Text người dùng gõ kèm khối giữ nguyên; danh sách thẻ bỏ trùng cấu hình được, mặc định `browser_instruction`
- Verify: `npm test` → test bỏ trùng pass (body đầy đủ, body chỉ có phần mới, khác phiên)
- File dự kiến: dedupe-blocks.mjs, pxlite.mjs, test.mjs
- Consumer: request Claude đi lên Anthropic
- Stub được phép: không

## T4 — Mô phỏng lời lỗ cache 1 giờ

- Lane: leaf
- Phụ thuộc: T2
- Phục vụ: DONE4
- AC1: `--ttl-sim` tính chi phí với TTL 5 phút và 1 giờ trên log có `session_id`, theo phần đầu ổn định (system cùng ảnh lịch sử)
- AC2: Kết luận bật hay không được ghi vào `## Quyết định` của SPEC kèm số liệu, chỉ dùng log ≥ 1 ngày sau T1
- Verify: `node scripts/cost-report.mjs --ttl-sim` → in hai con số chi phí và mức chênh
- File dự kiến: scripts/cost-report.mjs, test.mjs
- Consumer: T6, người dùng
- Stub được phép: không

## T6 — Bật cache 1 giờ cho phần đầu ổn định

- Lane: trunk
- Phụ thuộc: T4
- Phục vụ: DONE4, DONE6
- AC1: Chỉ làm khi T4 kết luận có lời; nếu không thì task chuyển `dropped`
- AC2: `ttl: "1h"` chỉ nằm trên dấu của phần đầu ổn định, các dấu sau nó vẫn 5 phút, đúng thứ tự máy chủ yêu cầu (dấu 1 giờ đứng trước dấu 5 phút)
- AC3: Tắt được bằng biến môi trường
- Verify: `npm test` → test `ttl` pass
- File dự kiến: overlay/dist/core/transform.js, test.mjs, overlay/manifest.json, patches/pxlite-vendor.patch
- Consumer: Anthropic Messages API
- Stub được phép: không
