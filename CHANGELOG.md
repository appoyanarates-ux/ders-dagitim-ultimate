# Sürüm Geçmişi (CHANGELOG)

Tüm sürümler Semantik Sürümleme (`MAJOR.MINOR.PATCH`) düzenini izler.

## [1.0.1] — 2026-11-23
- iyileştirmeler (Resmi MEB ders programı çıktı şablonları: öğretmen programı, sınıf programı, öğretmen çarşaf ve sınıf çarşaf tasarımları; blok ders yatay `colspan` birleştirme, `Ders Listesi` alt tablosu ve imza düzeni).

## [1.0.0] — 2026-11-23 (İlk Kararlı Adayı · Aşama 1–6)
### Eklenenler
- **Windows Masaüstü Paketi (NSIS x64):** `EvrakPlus-Ders-Dagitim-Setup-1.0.0.exe` (özel simge, Türkçe kurulum/kaldırma akışı, yönetici yetkisi gerektirmeyen kurulum, kaldırırken kullanıcı verilerini koruma uyarısı).
- **Gömülü Google OR-Tools CP-SAT Motoru (`onedir`):** Son kullanıcı bilgisayarında Python veya OR-Tools kurulumu gerekmez; bağımsız `validate_result.py` doğrulama modülü ile doğrulanmamış sonuç gösterilmez.
- **Yedi Ana Menü & MEB 2026–2027 Şablonları:** Okul profilleri, tekli/ikili öğretim zil saatleri, şube/öğretmen/özel derslik yönetimi, blok dersler, ortak seçmeli senkronizasyonu, öğretmen uygunluk matrisi.
- **Akıllı Manuel Düzenleme & Bölgesel Yeniden Dağıtım:** Sürükle-bırak taşıma, blok bütünlüğü, ders kilitleme (`block_id`), 40 adımlı Geri Al/İleri Al, seçili öğretmen/şube yeniden dağıtımı, en az değişiklikle onarım.
- **Profesyonel Çıktılar:** Gerçek PDF (`BrowserWindow.printToPDF`), 7 sayfalı formül-güvenli `.xlsx` çalışma kitabı, Toplu PDF/ZIP arşivi, canlı önizleme, kalite/pencere/yük raporları.
- **EvrakPlus Üyelik & Bulut Senkronizasyonu:** WordPress köprü eklentisi (`evrakplus-ders-dagitim-bridge` v1.0.0), cihaz eşleştirme, Windows DPAPI (`safeStorage`) şifreli oturum, 7 günlük imzalı çevrimdışı çıktı yetkisi, KVKK uyumlu opt-in bulut senkronizasyonu ve 409 çakışma çözümü.
- **Güvenli Güncelleme & Yedekleme:** `electron-updater` (kullanıcı onaylı indirme ve kurulum), Ed25519 manifest imza doğrulama yardımcısı, otomatik 10 yerel yedek + güncelleme öncesi yedek + beklenmedik kapanma kurtarma, hassas verilerden arındırılmış hata raporu, başlangıç sistem kontrolleri ve **Ayarlar ve Hakkında** ekranı.
- **GitHub Actions CI/CD:** `.github/workflows/ci-tests.yml` ve `.github/workflows/windows-release.yml` (asgari izinler, etiket ve imza doğrulamalı yayın kapısı).
