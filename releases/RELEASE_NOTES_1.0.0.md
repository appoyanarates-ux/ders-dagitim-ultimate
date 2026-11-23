# EvrakPlus Ders Dağıtım v1.0.0 — Sürüm Notları

**Yayın Tarihi:** 23 Kasım 2026  
**Uygulama Sürümü:** `1.0.0`  
**Proje Şema Sürümü:** `1.0.0`  
**Google OR-Tools Motoru:** `9.14.6206` (Python `3.12.10`, PyInstaller `onedir`)  
**WordPress Köprü Eklentisi:** `evrakplus-ders-dagitim-bridge v1.0.0`

## Öne Çıkan Yenilikler
- **Tamamen Çevrimdışı Google OR-Tools CP-SAT Ders Dağıtımı:** Python veya harici bileşen kurulumu gerektirmeden tekli/ikili öğretim, blok dersler, özel derslikler, öğretmen uygunlukları ve ortak seçmelileri çözer.
- **Akıllı Manuel Düzenleme & Kilitleme:** Sürükle-bırak taşıma, kilitleme, seçili şube/öğretmen yeniden dağıtımı ve 40 adımlı Geri Al / İleri Al.
- **Profesyonel PDF, Excel (.xlsx) ve Toplu ZIP Çıktıları:** Canlı önizleme, A4/A3 çarşaf bölme ve 4 parçalı kalite/pencere raporları.
- **EvrakPlus Üyelik & Bulut Senkronizasyonu:** Mevcut EvrakPlus WordPress hesaplarıyla cihaz eşleştirme, 7 günlük çevrimdışı çıktı yetkisi ve KVKK uyumlu opt-in bulut yedekleme.
- **Onaylı Güncelleme ve Yerel Yedekleme:** Kullanıcı onayı olmadan güncelleme indirmez veya kurmaz; güncelleme öncesi otomatik yerel proje yedeği alır.

## Kurulum ve İmzalama Notu
Bu geliştirme ortamında üretilen yerel `EvrakPlus-Ders-Dagitim-Setup-1.0.0.exe` dosyası kod imzalama sertifikası içermemektedir. Son kullanıcılara dağıtılacak kararlı üretim sürümü, GitHub Actions `windows-release.yml` iş akışında geçerli Windows kod imzalama sertifikası (`CSC_LINK`) ve Ed25519 manifest anahtarı (`EPDD_ED25519_PRIVATE_KEY`) ile imzalanarak yayınlanmalıdır.
