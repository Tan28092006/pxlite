# STATUS — pxlite: giảm chi phí cache

Spec: docs/specs/cache-cost/SPEC.md
Tasks: docs/specs/cache-cost/TASKS.md
Chế độ: tự chạy
Nghiệm thu: chưa
Giới hạn: xong 4 task
Cập nhật: 2026-11-18T16:00+07:00

## Bảng task

| ID | Task | Lane | Phụ thuộc | Trạng thái | Bằng chứng |
|---|---|---|---|---|---|
| T1 | Ghi mã phiên, vai trò và loại body vào events log | leaf | - | done | a7e9391; tasks/T1/qa-report.md (pass) |
| T2 | Script báo cáo chi phí cache | leaf | T1 | done | 0f75117; tasks/T2/qa-report.md (pass sau 1 vòng sửa) |
| T3 | Đặt dấu cache để ảnh lịch sử giống hệt được đọc lại | trunk | T1 | done | 7345c60; tasks/T3/qa-report.md (pass; DONE3 chờ log sau restart) |
| T5 | Bỏ trùng khối chèn lặp | leaf | T1 | done | QA pass; F4 sửa (skip theo Node); F1 request phụ có thể nhận marker, F3 thẻ lồng trong system-reminder vẫn bị thay — rủi ro thấp, theo dõi |
| T4 | Mô phỏng lời lỗ cache 1 giờ | leaf | T2 | done | 6857a9b; QA pass; F1 sửa: in thêm cận "delta giữ ấm". DONE4 chờ log ≥ 1 ngày: chạy lại `--ttl-sim` sau 2026-11-19T09:04Z |
| T6 | Bật cache 1 giờ cho phần đầu ổn định | trunk | T4 | blocked | chờ DONE4; chỉ làm nếu 1h có lời ở cả hai cận, và hỏi user trước |

## Chờ user

- (không có)

## Việc tiếp theo

- T1–T5 xong. Chạy lại `node scripts/cost-report.mjs --ttl-sim` khi log ≥ 1 ngày (sau 2026-11-19T09:04Z, tức 16:04 giờ +07), ghi kết luận vào `## Quyết định` của SPEC, rồi hỏi user về T6 (làm hoặc dropped).
- Mẫu hiện tại (chưa đủ 1 ngày): cache 1 giờ đắt hơn 21.4% toàn log; phiên OpenCode `ses_e108…` đắt hơn 39.5% (17 request). Nghiêng về bỏ T6.

## Kiểm tra cho OpenCode (2026-11-19)

- T1: request OpenCode có `session_id` (header `x-opencode-session-id`), `agent_role` (`subagent` khi có `x-opencode-parent-session-id`), `body_kind` luôn `full`.
- T2: phiên OpenCode xuất hiện trong `cost-report`.
- T3: phiên `ses_e108…` đạt DONE3 15/15 cặp, đọc cache 91.2%.
- T5: chạy chung đường `/v1/messages`, khóa theo mã phiên OpenCode; chưa có `browser_instruction` thật để kiểm chứng.
- T4: chưa đủ log; xem trên.
