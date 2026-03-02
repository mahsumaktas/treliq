# Treliq Nightly PR Scan — Plan

## Pipeline
1. Her gece 02:00 TR, `bulk-score-openclaw` çalışır
2. `--limit 500 --skip-cached --sort newest` — en yeniden en eskiye, cache'te olan atlanır
3. Model: Sonnet-only (cascade disabled) — OpenClaw kaliteli repo, %89 zaten Sonnet'e çıkıyor
4. Dedup: PR number = cache key (SQLite/JSON). Aynı PR tekrar skorlanmaz
5. Sonuç: `results/YYYY-MM-DD.json` dosyasına yazılır

## Çıktı (her sabah özet)
- Yeni skorlanan PR sayısı
- readyToSteal bulunanlar (ideaScore >= 70 + implScore >= 80 + state=CLOSED)
- Top 5 yeni keşif
- Tier dağılımı
- Kümülatif ilerleme (toplam skorlanan / toplam PR)

## Maliyet
- İlk 8 gece: ~$3.75/gece = ~$30 (mevcut ~4051 PR)
- Sonra: ~$0.30/gece (günde ~20-50 yeni PR)
- Aylık steady-state: ~$9

## Resume
- Her gece kaldığı yerden devam eder
- Cache'te olan PR atlanır
- Yeni PR'lar otomatik eklenir (gh API ile fetch)
- Repo'da ne kadar PR varsa hepsini tarar, sınır yok

## Cron Spec
```
Zamanlama: Her gece 02:00 TR (23:00 UTC)
Script: projects/treliq/scripts/nightly-scan.sh
Çıktı: results/ dizinine JSON + Markdown
Model: Sonnet 4.6
Timeout: 4 saat
```

## İlk Batch Durumu (24 Şub 2026)
- 500 PR skorlandı (cascade test)
- 35 readyToSteal bulundu
- Top 5: #24952 (92), #11888 (91), #13976 (85), #18219 (85), #17336 (85)
- 10 Critical, 180 High, 256 Normal, 54 Low
