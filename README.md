# Flashcard AI — Learning Upgrade

Bản nâng cấp giữ nguyên Gemini + local JSON hiện tại và bổ sung:

- Biết / Chưa nhớ cho từng flashcard.
- Tự động tính tiến bộ.
- Danh sách từ yếu.
- Danh sách từ đến lịch ôn.
- Lịch ôn tăng dần: 1, 3, 7, 14, 30, 60 ngày; trả lời sai sẽ quay về mức gần hơn.
- Luyện phát âm trực tiếp trên flashcard bằng Speech Recognition.
- Chấm điểm phát âm theo % dựa trên độ tương đồng transcript với từ mục tiêu.
- Theo dõi số lần luyện và độ chính xác phát âm.
- Tự migrate card cũ: card chưa có `learning` sẽ được bổ sung mặc định khi load.

## File

- `main.js`: Electron main process / BE hiện tại.
- `index.html`: giao diện renderer.

## IPC mới

- `mark-card-status`
- `submit-pronunciation`
- `get-learning-stats`

## Lưu ý

Tính năng nhận diện giọng nói cần Chromium/Electron hỗ trợ `SpeechRecognition` hoặc `webkitSpeechRecognition` và thường cần kết nối mạng để nhận diện giọng nói.
