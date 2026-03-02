# Scoring Aggregation & Multi-Signal Fusion Methods
## Deep Research for Treliq Automated Evaluation System
**Date:** 2026-02-24

---

## Executive Summary

Bu rapor, otomatik degerlendirme sistemleri (ozellikle PR/kod skorlama) icin uygulanabilir 12+ yontemi analiz eder. Yontemler **pratik uygulanabilirlik** ve **Treliq baglamindaki potansiyel** bazinda onceliklendirilmistir.

**TL;DR Oncelik Sirasi (Treliq icin):**
1. Rubric Decomposition + Calibrated Aggregation (en dusuk maliyet, en yuksek etki)
2. Ensemble LLM Judges (SE-Jury benzeri)
3. Bayesian Calibration with Uncertainty
4. Bradley-Terry Pairwise (opsiyonel, karsilastirmali ranking icin)
5. IRT-based Item Difficulty Modeling (benchmark kalitesi icin)
6. Dawid-Skene / MACE (coklu annotator durumunda)

---

## 1. ENSEMBLE SCORING (Multiple Weak Evaluators → Strong)

### Problem
Tek bir LLM judge bias'li, tutarsiz ve dar perspektifli olabilir. Position bias, verbosity bias, self-enhancement bias gibi sistematik hatalar uretir.

### Yontemler

#### 1a. Majority Voting (Baseline)
- N tane bagimsiz LLM judge'dan skor al, medyan/mod sec
- **Accuracy gain:** Basit averaging'e gore ~5-15% IRR iyilesmesi
- **Cost:** N x single evaluation (linear)
- **Limitation:** Sistematik bias'i duzeltemez (herkes ayni yonde yanilirsa)

#### 1b. Weighted Majority Voting (CWMV)
- Her evaluator'a guvenilirlik agirligi ata
- Agirliklar: gecmis performans, human-gold korelasyonu, veya Bayesian posterior'dan
- **Accuracy gain:** Uniform voting'e gore ~10-20% iyilesme
- **Cost:** Agirlik tahmini icin kalibrasyon seti gerekli (~50-100 gold label)

#### 1c. SE-Jury (State-of-the-Art for SE)
- **Paper:** [SE-Jury: An LLM-as-Ensemble-Judge Metric (ASE 2025)](https://arxiv.org/html/2505.20854v2)
- 5 farkli degerlendirme stratejisi, her biri bagimsiz judge
- Team selection mekanizmasi: her task icin en uygun judge alt-kumesini secer
- **Accuracy gain:** Human judgment korelasyonunda %29.6-%140.8 iyilesme (mevcut metriklere gore)
- **Cost:** Team selection sayesinde ~%50 LLM maliyeti azaltimi
- **Calibration:** Sadece 20 annotated sample yeterli
- **TRELIQ RELEVANCE:** Kod, patch, PR summary degerlendirmesi icin dogrudan uygulanabilir

#### 1d. Minority-Veto Ensemble
- Az sayida veto, "invalid" label'i zorlar
- TNR (True Negative Rate) onemli olcude artar
- **Use case:** Yuksek guvenilirlik gereken karar esikleri (score >= 80 gibi)

#### 1e. Meta-Judge (Judge-of-Judges)
- Guclu bir LLM, diger judge'larin ciktilarini degerlendirir
- Multi-dimensional rubric uzerinden agirlikli agregasyon
- **Cost:** Ekstra 1 LLM call (ama daha guclu model gerekli)

### Treliq Onerisi
SE-Jury benzeri bir yaklasim: 3-5 farkli prompt stratejisi (code quality, maintainability, security, relevance, complexity), her biri bagimsiz skor uretir. Lightweight kalibrasyon katmani ile human gold'a align edilir.

---

## 2. RANK AGGREGATION (Combining Rankings)

### Problem
Birden fazla ranker/evaluator farkli siralama urettiginde, tutarli bir "consensus ranking" olusturmak.

### 2a. Borda Count
- Her item, her ranker'daki pozisyonuna gore puan alir (N - rank)
- Tum ranker'lardan puanlar toplanir
- **Complexity:** O(n * k) — n item, k ranker
- **Properties:** Spearman korelasyonu optimize eder
- **Weakness:** Outlier ranker'lara hassas, Condorcet winner'i garanti etmez

### 2b. Kemeny-Young
- Tum ranker'lara minimum pairwise disagreement olan siralamayi bulur
- Kendall tau mesafesini minimize eder
- **Complexity:** NP-hard (exact), pratikte heuristic ile ~O(n^2 log n)
- **Properties:** Condorcet-consistent, neutral, tutarli
- **Paper:** [Dwork et al., "Rank Aggregation Revisited"](http://static.cs.brown.edu/courses/csci2531/papers/rank2.pdf)
- **Weakness:** Buyuk n icin hesaplama maliyeti yuksek

### 2c. Copeland's Method
- Pairwise karsilastirmada kac kez kazandigini say (galibiyet - maglubiyet)
- En basit Condorcet yontemi
- **Complexity:** O(n^2 * k)
- **Paper:** [Copeland Method for Group Decisions](https://thesai.org/Downloads/Volume4No6/Paper_32-Development_of_Copeland_Score_Methods_for_Determine_Group_Decisions.pdf)
- **Advantage:** Aciklamasi ve uygulamasi en kolay Condorcet yontemi
- **Weakness:** Ties cok olabilir

### Treliq Onerisi
PR sayisi (~1000) ve evaluator sayisi (3-5) icin Borda Count en pratik. Kemeny-Young, top-k ranking icin (ornegin "en iyi 10 PR") kullanilabilir.

---

## 3. RUBRIC DECOMPOSITION

### Problem
"Bu PR iyi mi?" gibi tek boyutlu soru, degerlendiriciyi zorlayarak tutarsiz sonuclar verir. Karmasik degerlendirme, alt boyutlara ayrildiginda daha guvenilir olur.

### 3a. LLM-Rubric (Microsoft, ACL 2024)
- **Paper:** [LLM-Rubric](https://aclanthology.org/2024.acl-long.745/)
- **Repo:** [github.com/microsoft/LLM-Rubric](https://github.com/microsoft/LLM-Rubric)
- Manual rubric tanimlama → her soru icin LLM distribution uretimi → kucuk NN ile kalibrasyon
- 9 boyutlu rubric (naturalness, conciseness, citation quality vb.)
- Overall satisfaction (1-4 scale) tahmininde RMSE < 0.5, baseline'a gore 2x iyilesme
- **Key Insight:** LLM'in raw skorlari dusuk korelasyon gosterir ama multi-dimensional response DISTRIBUTIONS'i birlestirildiginde yuksek korelasyon elde edilir
- Judge-specific ve judge-independent parametreler ile kisisellestirilmis kalibrasyon

### 3b. Recursive Rubric Decomposition (RRD)
- Ust-duzey rubric maddelerini daha ince alt-noktalara ayirir
- Daha kapsamli ve ayirt edici degerlendirmeler uretir
- **Advantage:** Ince farkliliklar yakalanir (ornegin "code quality" → readability + naming + complexity + error handling)

### 3c. PEARL Framework
- Rubric-driven multi-metric framework
- Her metrik icin ayri rubric, sonra weighted aggregation

### Treliq Onerisi (YUKSEK ONCELIK)
PR degerlendirmesi icin su rubric onerilir:
```
1. Code Correctness (bug riski, edge case handling)      — weight: 0.25
2. Maintainability (readability, complexity, naming)      — weight: 0.20
3. Security Impact (vulnerability, input validation)      — weight: 0.20
4. Relevance (macOS gateway, Treliq kapsaminda mi?)       — weight: 0.15
5. Scope & Risk (degisiklik buyuklugu, breaking change)   — weight: 0.10
6. Test Coverage (test eklemis mi, test bozmus mu?)       — weight: 0.10
```
Her boyut icin ayri LLM prompt → distribution → calibrated aggregation.

---

## 4. ITEM RESPONSE THEORY (IRT)

### Problem
Tum degerlendirme oge'leri (PR'ler) esit zorlukta degil. Bazi PR'ler herkes icin kolay/zor, bazilari ayirt edici. Evaluator'larin yetkinligi de degisken.

### 4a. Klasik IRT (2PL Model)
- Her item icin: difficulty (b) ve discrimination (a) parametreleri
- Her evaluator icin: ability (theta) parametresi
- P(correct | theta, a, b) = sigmoid(a * (theta - b))
- **Paper:** [Adaptive Testing for LLM Evaluation (ATLAS)](https://arxiv.org/html/2511.04689v2)
- **Accuracy gain:** Gerekli test item sayisini %90'a kadar azaltir (ayni olcum hassasiyetinde)

### 4b. tinyBenchmarks
- **Paper:** [tinyBenchmarks: Evaluating LLMs with Fewer Examples](https://arxiv.org/html/2402.14992v1)
- **Repo:** [github.com/felipemaiapolo/tinyBenchmarks](https://github.com/felipemaiapolo/tinyBenchmarks)
- IRT-based item selection: 14K MMLU sorusundan 100 tanesini secerek esit hassasiyette degerlendirme
- IRT embeddings, distribution shift'e karsi robust
- **Cost saving:** ~99% item azaltimi

### 4c. Graded Response Model (GRM) for Judge Reliability
- **Paper:** [Diagnosing Reliability of LLM-as-Judge via IRT](https://arxiv.org/html/2602.00521v1)
- Intrinsic consistency (prompt varyasyonlarina karsililik) + human alignment
- LLM judge'in guvenilirligini olcmek icin IRT-tabanli diagnostic framework

### 4d. AutoIRT
- **Paper:** [AutoIRT: Calibrating IRT with AutoML](https://arxiv.org/html/2409.08823v1)
- IRT parametre kalibrasyonunu otomatiklestiren AutoML yaklasimi

### Treliq Onerisi
PR'lerin "zorluk" parametresini (kac satir, kac dosya, ne kadar karisik diff) modellemek ve evaluator (LLM model) "yetkinlik" parametresini tahmin etmek icin hafif bir IRT katmani eklenebilir. Ozellikle "Haiku vs Sonnet hangi PR'lerde farkli skor veriyor?" analizi icin degerli.

---

## 5. BRADLEY-TERRY MODELS (Pairwise Comparison)

### Problem
Mutlak skor vermek zor, ama "A mi B mi daha iyi?" sorusu daha kolay ve guvenilir cevaplanir.

### 5a. Klasik Bradley-Terry
- P(A > B) = exp(s_A) / (exp(s_A) + exp(s_B))
- MLE ile latent "strength" parametreleri tahmin edilir
- **Paper:** [Bradley-Terry Model Wikipedia](https://en.wikipedia.org/wiki/Bradley%E2%80%93Terry_model)
- **Cost:** O(n^2) karsilastirma gerekli (n item icin), ama tum ciftlere gerek yok

### 5b. LMSYS Chatbot Arena Yaklasimi
- **Paper:** [Chatbot Arena: Benchmarking LLMs](https://arxiv.org/pdf/2403.04132)
- Elo'dan BT'ye gecis: daha stabil rating'ler ve hassas confidence interval'lar
- Statik performans varsayimi (model degismiyor) → MLE optimal
- **Key Insight:** BT, Elo'nun batch/offline versiyonu — tum oyunlari biliyorsan BT kullan

### 5c. Generalized Bradley-Terry (GBT)
- Binary karsilastirma yerine continuous/graded skor farki
- **Paper:** [GBT for Score Estimation](https://ojs.aaai.org/index.php/AAAI/article/view/30020/31794)

### Treliq Onerisi
4051 PR'yi pairwise karsilastirmak maliyetli (~8M cift). Ama "top-100 vs bottom-100" gibi stratified sampling ile BT kullanilabilir. Alternatif: mevcut skorlari BT ile kalibre etmek — iki PR'nin skorlari arasindaki fark, gercekten tercih olasiligini yansitir mi?

---

## 6. BAYESIAN APPROACHES

### Problem
Tek nokta tahmini (score = 82) yeterli degil. Uncertainty (82 +/- 12 vs 82 +/- 2) buyuk fark yaratir.

### 6a. Bayesian Calibration for LLM Judges
- **Paper:** [How to Correctly Report LLM-as-Judge Evaluations](https://arxiv.org/html/2511.21140)
- Epistemic uncertainty (judge kalitesi hakkinda belirsizlik) + aleatoric uncertainty (ornek varyasyonu)
- Random effects ile constancy assumption gucunu modelleme
- **Accuracy gain:** Coverage rate'lerde 20+ puan iyilesme

### 6b. Linear Probes for Calibrated Uncertainty
- **Paper:** [Calibrating LLM Judges: Linear Probes](https://arxiv.org/html/2512.22245v1)
- Reasoning judge'in hidden states'inden Brier-score-based loss ile linear probe
- ~10x computational savings, robust generalization
- **Limitation:** Model internal states'e erisim gerektirir (API model icin uygulanamaz)

### 6c. Bayesian Human-AI Complementarity
- **Paper:** [Bayesian modeling of human-AI complementarity (PNAS)](https://www.pnas.org/doi/10.1073/pnas.2111547119)
- Insan ve makine prediction + confidence score'larini Bayesian framework ile birlestirme
- Hybrid kombine performansi, tek basina insan veya makine performansini asiyor

### 6d. Calibration Dataset Approach
- Kucuk "calibration" dataset (human ground truth) ile LLM judge bias'ini duzeltme
- Confidence interval olusturma
- **Practical:** 50-100 gold label yeterli

### Treliq Onerisi (YUKSEK ONCELIK)
Her PR skoru icin uncertainty estimate ekle:
```
{
  "score": 82,
  "confidence": 0.85,      // posterior certainty
  "uncertainty_range": [74, 90],  // %95 credible interval
  "calibration_source": "50 human-labeled PRs"
}
```
Score >= 80 threshold'unda uncertainty yuksekse, human review'a yonlendir.

---

## 7. HUMAN-AI HYBRID SCORING

### Problem
LLM judge ucuz ama imperfect; human review dogru ama pahali. Optimal karisim nasil?

### 7a. Two-Stage Pipeline
- Stage 1: LLM tum item'lari skorlar
- Stage 2: Low-confidence veya threshold-yakin item'lar human'a gider
- **Cost reduction:** Human effort %60-80 azalir
- **Accuracy:** Tam human review'a yakin (%95+)

### 7b. Calibration-Then-Predict
- Instructor kucuk bir ornek kumesini skorlar → LLM bu orneklerden kalibrasyon ogrenir
- Rubric + sample-graded work = model alignment
- **Paper:** [Rubric-Based AI Auto-Grading](https://8allocate.com/blog/rubric-based-ai-auto-grading-ensuring-accuracy-mitigating-bias-upholding-integrity/)

### 7c. Complementarity-Aware Routing
- Bayesian model ile "bu item'da insan mi AI mi daha iyi?" tahmin et
- Dynamic routing: kolay olanlar AI'a, zor olanlar insana
- **Key Factor:** Human metacognition (kendi performansini dogru degerlendirme) kritik

### Treliq Onerisi
Mevcut workflow'a uygun: LLM tum PR'lari skorlar → score 70-85 arasindakiler (belirsiz bolge) human review'a flag'lenir → human karar verir → human kararlari gelecek kalibrasyon icin feedback loop'a girer.

---

## 8. ACTIVE LEARNING FOR EVALUATION

### Problem
Sinirli human annotation butcesiyle hangi item'lari skorlatmak maximum kalibrasyon saglar?

### 8a. Uncertainty Sampling
- LLM'in en belirsiz oldugu item'lari human'a sor
- **Efficiency gain:** Random sampling'e gore %30-58 annotation azaltimi
- **Weakness:** Exploration-exploitation dengesizligi

### 8b. Query-by-Committee (QBC)
- Birden fazla model/prompt'un en cok anlasmazlik gosterdigi item'lari sec
- **Paper:** [Active Learning Methods for Essays](https://arxiv.org/pdf/2301.00628)
- **Use case:** Farkli LLM judge'larin en cok disagreement gosterdigi PR'lar

### 8c. Hybrid Strategies (Exploration + Exploitation)
- Uncertainty + diversity sampling birlestirme
- En iyi F1 area-under-curve
- **Practical:** Batch-mode active learning — her turda K item sec

### 8d. Annotator-Centric Active Learning
- **Paper:** [Annotator-Centric Active Learning for Subjective NLP Tasks (EMNLP 2024)](https://aclanthology.org/2024.emnlp-main.1031.pdf)
- Subjective task'larda annotator perspektifini koruyarak selection

### Treliq Onerisi
1. Ilk tur: Random 50 PR'yi human skorla (baseline)
2. Sonraki turlar: LLM ensemble disagreement en yuksek olan PR'leri human'a gonder
3. Her 100 yeni human label'da calibration model'i guncelle
4. Hedef: ~200 human label ile %95+ accuracy

---

## 9. ELO / GLICKO RATING SYSTEMS

### Problem
Zaman icinde gelisen bir evaluation sistemi — yeni PR'lar geldikce rating'ler guncellensin.

### 9a. Elo Rating (Adapted)
- Her karsilastirmadan sonra rating guncellenir
- K-factor ile hassasiyet kontrolu
- **Weakness:** Siralama duyarli (ayni karsilastirmalar farkli sirada → farkli sonuc)
- **Use case:** Online/streaming evaluation

### 9b. Glicko-2
- Rating + Rating Deviation (RD) + Rating Volatility
- RD yuksek = az degerlendirilmis, dusuk guven
- **Paper:** [Glickman's Glicko System](https://www.glicko.net/glicko/glicko.pdf)
- **Advantage over Elo:** Uncertainty quantification built-in
- **Applied:** Evolutionary algorithm ranking'de Glicko-2 en uygun secim

### 9c. Elo-MMR (Massive Multiplayer)
- **Paper:** [Elo-MMR (Stanford)](https://cs.stanford.edu/people/paulliu/files/www-2021-elor.pdf)
- Cok oyunculu yarislar icin Elo genellemesi
- Batch comparison'lar icin uygun

### 9d. LMSYS Gecisi: Elo → Bradley-Terry
- Tum veri mevcut oldugundan Elo'nun online avantaji kaybolur
- BT, batch MLE ile daha stabil ve daha hassas
- **Tavsiye:** Tum data mevcut ise BT kullan, streaming ise Elo/Glicko

### Treliq Onerisi
Treliq'te tum PR'lar batch olarak skorlandigi icin, pure Elo/Glicko gereksiz. Ama gelecekte "yeni PR geldi, hizlica score ver" icin Glicko-2 benzeri incremental update mantikli.

---

## 10. DAWID-SKENE / MACE (Multi-Annotator Aggregation)

### Problem
Birden fazla annotator (insan veya LLM) farkli guvenilirlikte. Gercek label ne?

### 10a. Dawid-Skene Model
- Her annotator icin confusion matrix modeller (EM ile)
- True label'i latent variable olarak tahmin eder
- **Paper:** Dawid & Skene (1979), [Blog](https://michaelpjcamilleri.wordpress.com/2020/06/22/reaching-a-consensus-in-crowdsourced-data-using-the-dawid-skene-model/)
- **Performance:** Majority voting'i tutarli olarak gec
- **Speed:** Fast Dawid-Skene (FDS) — [Paper](https://arxiv.org/pdf/1803.02781) — cok az iterasyonla ayni dogruluk

### 10b. MACE (Multi-Annotator Competence Estimation)
- **Repo:** [github.com/dirkhovy/MACE](https://github.com/dirkhovy/MACE)
- Variational Bayes EM ile annotator competence + true label ayni anda
- Annotator "biliyor" vs "tahmin ediyor" modeli
- Semi-supervised: control items (bilinen dogru cevaplar) eklenebilir
- Discrete categorical + continuous numeric destegi
- **Advantage:** Spammer detection built-in

### 10c. ZenCrowd / KOS / IWMV
- ZenCrowd: EM-based worker reliability
- KOS: Belief propagation
- IWMV: Iterative weighted majority voting
- Hepsi Dawid-Skene ailesinin varyantlari

### Treliq Onerisi
Eger Treliq'te birden fazla LLM model (Haiku, Sonnet, Opus) veya birden fazla prompt stratejisi kullaniliyorsa, Dawid-Skene ideal. Her "annotator" (model/prompt) icin confusion matrix ogrenilir, guvenilir olanlarin agirligi artar.

---

## KARSILASTIRMA TABLOSU

| Yontem | Accuracy Gain vs Avg | Compute Cost | Calibration Data | PR/Code Uygulamasi | Implementasyon Zorlu |
|--------|---------------------|--------------|------------------|-------------------|---------------------|
| Majority Vote | +5-15% | Low (N calls) | 0 | Dogrudan | Kolay |
| Weighted Vote (CWMV) | +10-20% | Low (N calls) | 50-100 gold | Dogrudan | Kolay |
| SE-Jury Ensemble | +30-140% | Medium (3-5 calls) | 20 samples | Dogrudan (SE icin tasarlanmis) | Orta |
| Rubric Decomposition | +100% (2x RMSE) | Medium (K dimensions) | 50-100 gold | Dogrudan | Orta |
| Bayesian Calibration | +20pt coverage | Low (post-hoc) | 50-100 gold | Dogrudan | Orta |
| Bradley-Terry | N/A (ranking) | High (O(n^2) pairs) | Pairwise labels | Sampling ile | Orta |
| IRT | %90 item azaltimi | Medium (fitting) | Gecmis evaluations | Benchmark kalitesi | Zor |
| Dawid-Skene/MACE | >Majority Vote | Low (EM iterations) | 0 (unsupervised) | Multi-judge durumunda | Kolay |
| Elo/Glicko | N/A (online rating) | Very Low | 0 | Streaming evaluation | Kolay |
| Active Learning | -%58 annotation | Medium | Iterative | Human-in-loop | Orta |
| Borda Count | N/A (ranking) | Very Low | 0 | Multi-ranker | Cok Kolay |
| Human-AI Hybrid | -%60-80 human cost | Low (routing) | 50+ gold | Threshold-based | Orta |

---

## TRELIQ ICIN ONERILEN MIMARI

### Phase 1: Quick Wins (1-2 gun)
1. **Rubric Decomposition**: Tek prompt yerine 6 boyutlu rubric
2. **Weighted Aggregation**: Boyut skorlarini agirlikli birlestirme
3. **Confidence Score**: Her skor icin uncertainty estimate

### Phase 2: Calibration (3-5 gun)
4. **Gold Label Set**: 50-100 PR'yi manual skorla
5. **Bayesian Calibration**: LLM raw skor → calibrated skor mapping
6. **Active Learning Loop**: Disagreement-based human review routing

### Phase 3: Advanced (1-2 hafta)
7. **SE-Jury Style Ensemble**: 3-5 farkli judge stratejisi
8. **Dawid-Skene**: Multi-model (Haiku vs Sonnet) reliability modeling
9. **IRT Layer**: PR difficulty + model ability parametreleri

### Phase 4: Optimization (ongoing)
10. **Bradley-Terry**: Top-tier PR'larin relative ranking'i
11. **Glicko-2**: Incremental scoring for new PRs
12. **Feedback Loop**: Human corrections → model recalibration

---

## KAYNAKLAR

### Ensemble & Multi-Judge
- [SE-Jury: LLM-as-Ensemble-Judge (ASE 2025)](https://arxiv.org/html/2505.20854v2)
- [Confidence-Weighted Majority Voting](https://www.emergentmind.com/topics/confidence-weighted-majority-voting)
- [The Majority Vote Paradigm Shift](https://arxiv.org/abs/2502.12581)

### Rubric & Calibration
- [LLM-Rubric (ACL 2024, Microsoft)](https://aclanthology.org/2024.acl-long.745/)
- [LLM-Rubric GitHub](https://github.com/microsoft/LLM-Rubric)
- [PEARL Framework](https://www.mdpi.com/2078-2489/16/11/926)
- [Recursive Rubric Decomposition](https://www.researchgate.net/publication/400506257)

### Bradley-Terry & Pairwise
- [Chatbot Arena: Benchmarking LLMs (LMSYS)](https://arxiv.org/pdf/2403.04132)
- [Elo vs Bradley-Terry Comparison](https://hippocampus-garden.com/elo_vs_bt/)
- [Generalized Bradley-Terry (AAAI)](https://ojs.aaai.org/index.php/AAAI/article/view/30020/31794)
- [PEAR: Pairwise Evaluation](https://arxiv.org/abs/2601.18006)

### IRT & Adaptive Testing
- [ATLAS: Adaptive Testing for LLM Evaluation](https://arxiv.org/html/2511.04689v2)
- [tinyBenchmarks](https://arxiv.org/html/2402.14992v1)
- [Diagnosing LLM-as-Judge via IRT](https://arxiv.org/html/2602.00521v1)
- [AutoIRT](https://arxiv.org/html/2409.08823v1)
- [Lost in Benchmarks? IRT for LLM Benchmarking](https://arxiv.org/html/2505.15055v1)

### Bayesian & Uncertainty
- [How to Correctly Report LLM-as-Judge Evaluations](https://arxiv.org/html/2511.21140)
- [Calibrating LLM Judges: Linear Probes](https://arxiv.org/html/2512.22245v1)
- [Bayesian Human-AI Complementarity (PNAS)](https://www.pnas.org/doi/10.1073/pnas.2111547119)
- [Uncertainty Quantification Survey](https://arxiv.org/html/2503.15850)

### Multi-Annotator Aggregation
- [Dawid-Skene Model Blog](https://michaelpjcamilleri.wordpress.com/2020/06/22/reaching-a-consensus-in-crowdsourced-data-using-the-dawid-skene-model/)
- [Fast Dawid-Skene](https://arxiv.org/pdf/1803.02781)
- [MACE GitHub](https://github.com/dirkhovy/MACE)

### Rank Aggregation
- [Rank Aggregation Revisited (Dwork et al.)](http://static.cs.brown.edu/courses/csci2531/papers/rank2.pdf)
- [Copeland Score Methods](https://thesai.org/Downloads/Volume4No6/Paper_32-Development_of_Copeland_Score_Methods_for_Determine_Group_Decisions.pdf)
- [ranky Python Library](https://pypi.org/project/ranky/)

### Elo & Rating Systems
- [Glicko System (Glickman)](https://www.glicko.net/glicko/glicko.pdf)
- [Elo-MMR (Stanford)](https://cs.stanford.edu/people/paulliu/files/www-2021-elor.pdf)

### Active Learning
- [Active Learning for Essays](https://arxiv.org/pdf/2301.00628)
- [Annotator-Centric Active Learning (EMNLP 2024)](https://aclanthology.org/2024.emnlp-main.1031.pdf)

### Inter-Rater Reliability
- [Improving Inter-Rater Reliability](https://www.deepchecks.com/improving-inter-rater-reliability-practices-strategies/)
- [Inter-Rater Reliability (CAEP)](https://caepnet.org/terms/inter-rater-reliability/)
