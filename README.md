# MNR API

Drop-in backend replacement for the Supabase `ocr-process` edge function.  
Uses **Anthropic Claude claude-sonnet-4-6** for medical form OCR.

## Endpoint

**POST** `/ocr-process`

### Request body
```json
{
  "imageData": "data:image/jpeg;base64,...",
  "isPDF": false,
  "pageNumber": 1,
  "totalPages": 1
}
```

### Response
```json
{ "text": "extracted OCR text..." }
```

## Setup

```bash
cp .env.example .env
# Fill in ANTHROPIC_API_KEY
npm install
npm start
```

## Deploy (Railway)

1. Push this repo to GitHub
2. Create new Railway service → connect repo
3. Set env var: `ANTHROPIC_API_KEY=sk-ant-...`
4. Railway auto-deploys on push

## Frontend change

In `ocrService.ts`, change the fetch URL from:
```
${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ocr-process
```
to:
```
${import.meta.env.VITE_OCR_API_URL}/ocr-process
```
And remove the `Authorization` header (not needed anymore).
