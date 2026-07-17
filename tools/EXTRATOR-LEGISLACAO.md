# Extrator de Legislacao (PDF/Imagem -> JSON)

O script `tools/extrair-legislacao.js` converte arquivos de legislacao em JSON no formato esperado pelo importador (`server/importar-legislacao.js`).

## 1) Uso rapido

```bash
npm run extrair:legislacao -- --input "caminho/arquivo.pdf" --nome "Codigo Civil" --output "dados/codigo-civil.json"
```

Depois, importar para o banco:

```bash
node server/importar-legislacao.js dados/codigo-civil.json
```

## 2) Formatos suportados

- PDF (`.pdf`)
- Imagem (`.png`, `.jpg`, `.jpeg`, `.tif`, `.tiff`, `.bmp`, `.webp`)
- Texto (`.txt`)

## 3) OCR

- PDF com texto digital: usa `pdftotext`
- PDF escaneado: tenta OCR automatico (se texto extraido for curto)
- Imagens: OCR obrigatorio

Dependencias de sistema:

- `pdftotext` (poppler-utils)
- `pdftoppm` (poppler-utils)
- `tesseract` (para OCR)

Se `tesseract` nao estiver instalado, PDF textual ainda funciona; imagens nao.

## 4) Opcoes principais

```bash
--input, -i       Arquivo de entrada
--output, -o      Arquivo JSON de saida
--nome, -n        Nome da legislacao
--id              ID da legislacao (slug automatico se omitido)
--descricao       Descricao opcional
--fundamentacao   Fundamentacao opcional
--ocr             auto | always | never
--lang            Idioma OCR (padrao: por)
--raw-text        Salva texto bruto extraido
--min-text        Minimo de caracteres para evitar OCR em PDF (padrao: 500)
--columns         Numero de colunas (1 ou 2) para OCR (padrao: 1)
```

## 5) Fluxo recomendado

1. Extrair:

```bash
npm run extrair:legislacao -- --input "docs/lei.pdf" --nome "Lei X" --output "dados/lei-x.json" --raw-text "dados/lei-x.txt"
```

2. Revisar rapidamente `dados/lei-x.json` e `dados/lei-x.txt`.

3. Importar:

```bash
node server/importar-legislacao.js dados/lei-x.json
```

4. Abrir `legislacao.html` e validar a renderizacao no leitor.

## 6) Observacoes

- A deteccao de estrutura (Livro/Titulo/Capitulo/Secao/Subsecao) e automatica por regex.
- A deteccao de `Art.` / `§` / `a)` tambem e automatica.
- Em PDFs/imagens com baixa qualidade, ajuste OCR (`--ocr always`) e revise o JSON antes de importar.
- Para documentos em duas colunas, use `--columns 2` (requer `python3` + `Pillow` + `tesseract`).
