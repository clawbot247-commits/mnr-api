import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
const PORT = process.env.PORT || 3001;

// ── CORS ──────────────────────────────────────────────────────────────────────
// Allow Lovable frontend domains + localhost for dev
app.use(cors({
  origin: [
    /\.lovable\.app$/,
    /\.lovableproject\.com$/,
    /localhost/,
    /127\.0\.0\.1/,
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'apikey', 'x-client-info'],
}));

app.use(express.json({ limit: '50mb' }));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', service: 'mnr-api', model: 'claude-sonnet-4-6' }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── OCR endpoint (drop-in replacement for Supabase edge function) ─────────────
app.post('/ocr-process', async (req, res) => {
  try {
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured' });
    }

    const { imageData, isPDF, pageNumber, totalPages } = req.body;

    if (!imageData) {
      return res.status(400).json({ error: 'No image data provided' });
    }

    console.log(`Processing ${isPDF ? 'PDF page' : 'image'} ${pageNumber}/${totalPages}...`);

    // Parse base64 data URL → media_type + base64 data
    // Frontend sends: "data:image/jpeg;base64,/9j/..."
    const dataUrlMatch = imageData.match(/^data:([^;]+);base64,(.+)$/);
    if (!dataUrlMatch) {
      return res.status(400).json({ error: 'Invalid image data format (expected data: URL)' });
    }
    const mediaType = dataUrlMatch[1]; // e.g. "image/jpeg"
    const base64Data = dataUrlMatch[2];

    // Validate media type — Anthropic supports jpeg, png, gif, webp
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(mediaType)) {
      return res.status(400).json({ error: `Unsupported image type: ${mediaType}` });
    }

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

    // ── OCR prompt (identical to Supabase edge function) ──────────────────────
    const ocrPrompt = `Extract ALL text from this medical document/form${isPDF ? ` (page ${pageNumber})` : ''}.

CRITICAL OUTPUT RULES:
- Output ONLY extracted text/values. No advice. No instructions.
- Never say you "can't extract" or "can't view images".
- If a value is not present or unreadable, output it as blank or [illegible].

=====================================================================
PHYSICIAN-ONLY FIELDS — DO NOT EXTRACT, LEAVE BLANK:
The following fields are filled in by the physician/practitioner, NOT the patient.
Never populate these fields, even if you can read text near them:
- Pulse / Pulse Signs / Pulse Signs Rx
- Tongue Signs / Tongue Signs Rx
- Vital signs recorded by physician (separate from patient-reported height/weight/BP)
- Treatment Plan / Treatment Goals (physician section)
- Functional Outcome Tool fields
- Any field in a section labeled "For Office Use Only" or "Practitioner Use Only"
=====================================================================

CHECKBOX FIELDS — REPORT ONLY WHAT IS PHYSICALLY MARKED:
For every YES/NO or M/F checkbox, look for a physical mark (X, checkmark, circle, filled box).
NEVER infer or default a value. ONLY report what is visually marked on the form.

1. **GENDER**: Look for "M / F" or "M/F" near the bottom right of the form (near Height/Weight/B/P fields).
   - One letter will have a circle, X, or checkmark on or next to it.
   - Output EXACTLY: GENDER_CIRCLED: M  OR  GENDER_CIRCLED: F
   - DO NOT guess gender from the patient's name or any other text.
   - This is MANDATORY — look very carefully at the physical marks.

2. **ARE YOU UNDER THE CARE OF A PHYSICIAN?**: Find the line "Are you under the care of a physician?" or "Being Cared for By a Medical Physician?"
   - The form may use UNDERLINES (No___ Yes___) OR CHECKBOXES (□ No ☑ Yes / ☑ No □ Yes).
   - For UNDERLINES: The patient writes an X, checkmark (✓), or mark ON or OVER the underline.
     - "No_✓_" or "No_X_" or "No ✓" = mark is on the No underline → UNDER_PHYSICIAN_CARE: NO
     - "Yes_✓_" or "Yes_X_" = mark is on the Yes underline → UNDER_PHYSICIAN_CARE: YES
   - For CHECKBOXES: Look at which box is filled/checked (☑, ✓, X, ■, ●) vs empty (□, ○).
     - ☑ No □ Yes = No is checked → UNDER_PHYSICIAN_CARE: NO
     - □ No ☑ Yes = Yes is checked → UNDER_PHYSICIAN_CARE: YES
   - EXAMPLE: "No__✓__ Yes______" → the checkmark is on the No underline → UNDER_PHYSICIAN_CARE: NO
   - KEY RULE: The mark's LEFT/RIGHT position determines the answer. If the mark sits directly after "No" and before "Yes", it belongs to "No".
   - CRITICAL: Do NOT infer YES because "For what conditions?" has text filled in below — ignore that field entirely for this question.
   - Output EXACTLY one of: UNDER_PHYSICIAN_CARE: YES  OR  UNDER_PHYSICIAN_CARE: NO  (nothing else)

3. **PREGNANT?**: Find the line that reads "Pregnant? No___ Yes___" near Height/Weight/B/P at the bottom right.
   - The form uses UNDERLINES (not boxes). The patient writes an X, checkmark, or mark ON or OVER the underline.
   - "No_X_" or "No X" or "No__X__" = the X is on the No underline → PREGNANT: NO
   - "Yes_X_" or "Yes X" or "Yes__X__" = the X is on the Yes underline → PREGNANT: YES
   - Look at WHERE the X/mark sits: if it's closer to "No" (left side), output PREGNANT: NO. If closer to "Yes" (right side), output PREGNANT: YES.
   - EXAMPLE from this form type: "Pregnant? No_X_ Yes____" → output PREGNANT: NO
   - Output EXACTLY one of: PREGNANT: YES  OR  PREGNANT: NO  (nothing else on that line)
   - CRITICAL: An X or mark anywhere on or near the No underline = PREGNANT: NO. Do NOT leave this blank.
   - IF PREGNANT IS NO: output WEEKS_PREGNANT: (leave completely blank)
   - IF PREGNANT IS YES: extract the number from "# of weeks ___" and output WEEKS_PREGNANT: [number]

=====================================================================

Pay special attention to:

1. Patient information (name, DOB, phone, address, insurance, etc.)
   **IMPORTANT - BOTTOM SECTION FIELDS (Insurance Information Area)**: At the bottom of the document, there is a section where patient info and insurance info appear SIDE-BY-SIDE on the same lines. Extract ALL of these fields:
   - **Patient Name** - Full name appearing on the LEFT side of the line, TO THE LEFT OF "Health Plan" (separated by spaces). Output as: PATIENT_NAME_BOTTOM: [name]
   - **Health Plan** - Insurance plan name on the RIGHT side of the same line (labeled as "Health Plan:")
   - **Patient Address** - Street address appearing on the LEFT side of the next line, TO THE LEFT OF "ID #" (separated by spaces). Output as: PATIENT_ADDRESS_BOTTOM: [address]
   - **Subscriber ID** - ID number on the RIGHT side of the same line (labeled as "ID #:" or "ID #"). This is a critical field — read EACH DIGIT ONE AT A TIME from left to right. Copy ONLY the exact digits with no extra characters, spaces, or adjacent text. Double-check every digit before outputting. Output as: SUBSCRIBER_ID: [exact value]
   - **Patient City/State/Zip** - City, State ZIP appearing on the LEFT side of the next line, TO THE LEFT OF "Group #" (separated by spaces)
   - **Group Number** - The value labeled "Group #" — copy ONLY the exact digits/letters of the group number with no extra characters, spaces, or adjacent text. Output as: GROUP_NUMBER: [exact value]
   - **Patient Phone** - Phone number in format like (XXX) XXX-XXXX appearing near the Date/Signature area. Copy each digit carefully one at a time. Output as: PATIENT_PHONE: [phone]

2. **Additional Patient Information:**
   - Primary Care Physician
   - Physician Phone Number
   - Employer
   - Job Description
   - "Are you under the care of a physician?" → output using UNDER_PHYSICIAN_CARE: format above
   - "For what conditions?"

3. **HEALTH PROBLEM INFORMATION:**
   - "Current health problem(s)" - describe current health issues
   - "When it began?" - when the problem started
   - "How it happened?" - how the problem occurred
   - "What treatment have you received for the above condition(s)?" - treatments received
   - "How often are your symptoms in the past week?" - frequency of symptoms

4. **ICD CODES AND CONDITIONS** - Look for ICD-10 codes and associated conditions/diagnoses. Format each as:
   ICD_CODE: [code] = [condition]
   For example: ICD_CODE: M54.5 = Low back pain
   Extract up to 4 ICD code-condition pairs.

5. Medical data (diagnosis, medications, allergies)
   **CRITICAL - PAIN MEDICATION FIELD**: Look for the field labeled "Pain Medication (Name, Dosage, Frequency):".
   - Extract ONLY the handwritten text inside that specific field.
   - STOP at the next field boundary — do NOT include text from adjacent sections, checkboxes, or crossed-out content.
   - Do NOT include text from "Nutritional Supplements", "Prescription Medication(s)" checkboxes, or any other nearby fields.
   - Always output exactly once: PAIN_MEDICATION: [medication info or blank]

6. **PAIN ASSESSMENT SCALES — MANDATORY STRUCTURED OUTPUT**:
   Find each of these pain scale questions. Each has a row of numbers 0 1 2 3 4 5 6 7 8 9 10 and the patient circles ONE number.
   - "Current Pain Level" → find the circled/marked number → output: PAIN_CURRENT: [number]
   - "Average Pain Level in the past week" → output: PAIN_AVERAGE: [number]
   - "Worst Pain Level in the past week" → output: PAIN_WORST: [number]
   - "How has it interfered with your daily activity" → output: PAIN_INTERFERENCE: [number]
   **CRITICAL**: Output ONLY the single circled/marked number (0-10). IGNORE the printed scale sequence. IGNORE descriptive notes like "(*10 = Excruciating)".
   **CRITICAL**: Do NOT output 0 unless 0 is actually circled/marked. If unreadable, output [illegible].

7. **PAIN LOCATION — MANDATORY STRUCTURED OUTPUT**:
   Find the body area/location where the patient reports pain. This is typically found in "Current health problem(s)" or near "Location" fields.
   Extract the BODY PART or ANATOMICAL LOCATION (e.g., "lower back", "neck", "left shoulder", "bilateral knees").
   Do NOT put medical conditions (like "high blood pressure") here — only body locations.
   Output EXACTLY: PAIN_LOCATION: [body location]

8. **DATE FIELDS — COPY EACH DIGIT CAREFULLY**:
   For all date fields (Date of Birth, Today's Date, When it began, etc.):
   - Copy each digit one at a time. Do not skip or merge digits.
   - Common format: MM/DD/YY or MM/DD/YYYY.
   - Example: if you see "7/12/25", output exactly "7/12/25" — do not truncate to "7/2/25".

7. **HOW IT HAPPENED — MANDATORY STRUCTURED OUTPUT**:
   Find the field "How it happened?" and output EXACTLY:
   HOW_IT_HAPPENED: [whatever is written, even if just "u/n", "unknown", or a single word]
   - Do NOT skip this even if the answer is short (1-3 chars like "u/n" is valid).
   - If truly blank, output: HOW_IT_HAPPENED: (blank)

8. **SYMPTOM FREQUENCY — MANDATORY STRUCTURED OUTPUT**:
   Find "How often are your symptoms in the past week?" — it has percentage ranges each followed by an underline:
   0-10%___ 11-20%___ 21-30%___ 31-40%___ 41-50%___ 51-60%___ 61-70%___ 71-80%___ 81-90%___ 91-100%___
   The patient writes an X, checkmark (✓), or mark ON the underline next to their chosen range.
   - "91-100%_✓_" = 91-100% is selected
   - "51-60%_X_" = 51-60% is selected
   Look for the ONE range that has a mark on its underline and output EXACTLY:
   SYMPTOM_FREQUENCY: [the marked range, e.g. "91-100%" or "51-60%"]
   - If none marked, output: SYMPTOM_FREQUENCY: (blank)

9. **ACTIVITY TABLE — MANDATORY STRUCTURED OUTPUT**:
   Find the table "List the activities (sleep, work, recreation) you are monitoring for progress..."
   It has 3 columns: Activity | Measurements (how much, how long, how far?) | How has it changed
   For EACH row that has any data written, output EXACTLY on its own line:
   ACTIVITY_ROW_1: [activity text] | [measurements text] | [how has it changed text]
   ACTIVITY_ROW_2: [activity text] | [measurements text] | [how has it changed text]
   ACTIVITY_ROW_3: [activity text] | [measurements text] | [how has it changed text]
   - If a cell is blank/empty, leave it empty between pipes: e.g. ACTIVITY_ROW_1: sleep | 8 hours | 
   - If a row is completely blank (no activity), omit that row entirely.
   - THIS IS MANDATORY — even if the table looks simple or has only 1-2 rows.

10. **RELIEF DURATION — MANDATORY STRUCTURED OUTPUT**:
    Find "How long does relief last?" — the format is: "Hours___ if so, how many___ Days___ if so, how many___"
    These use UNDERLINES (not boxes). The patient marks an X or checkmark (✓, ✗, √) ON the underline next to "Hours" or "Days".
    - "Hours_✓_" or "Hours_X_" = Hours is selected → look at "if so, how many" after Hours for the number
    - "Days_✓_" or "Days_X_" = Days is selected → look at "if so, how many" after Days for the number
    - The number field may have text like "one", "1", "2", "2/3", or other handwritten values
    Output EXACTLY one line:
    RELIEF_DURATION: [number] [hours or days]
    Examples:
      Hours ✓, if so how many = "one" → RELIEF_DURATION: 1 hour
      Hours ✓, if so how many = "2" → RELIEF_DURATION: 2 hours
      Days ✓, if so how many = "3" → RELIEF_DURATION: 3 days
      Hours ✓, if so how many = "2/3" → RELIEF_DURATION: 2-3 hours
    - If neither is marked or value is illegible, output: RELIEF_DURATION: (blank)

11. **SUBSCRIBER ID VERIFICATION — MANDATORY TWO-PASS CHECK**:
   After extracting ALL other fields, go BACK to the "ID #:" field and perform this verification:
   Step 1: Locate the "ID #:" label in the bottom-right insurance area.
   Step 2: Look at the digits to the RIGHT of "ID #:". For each digit from left to right, describe its SHAPE:
     - A round closed oval = 0 (zero)
     - A vertical stroke = 1 (one)
     - A loop on top with a descending tail = 9 (nine)
     - A loop on the bottom with an ascending stroke = 6 (six)
     - A curved stroke with a horizontal bar = 5 (five)
     - Two curves stacked = 8 (eight)
     - A curved stroke ending in a point = 3 (three)
   Step 3: Output: SUBSCRIBER_ID_VERIFY: [shape1=digit, shape2=digit, ...] → [final number]
   Example: SUBSCRIBER_ID_VERIFY: oval=0, oval=0, stroke=1, stroke=1, loop-tail=9, oval=0, bottom-loop=6, loop-tail=9, oval=0, curve-point=3 → 0011906903
   Step 4: If SUBSCRIBER_ID_VERIFY result differs from the SUBSCRIBER_ID extracted earlier, USE the VERIFY value as the correct one and update SUBSCRIBER_ID accordingly.

Return the extracted text preserving formatting. Use the MANDATORY STRUCTURED OUTPUT formats above for pain scales (PAIN_CURRENT, PAIN_AVERAGE, PAIN_WORST, PAIN_INTERFERENCE), PAIN_LOCATION, SYMPTOM_FREQUENCY, ACTIVITY_ROW_N, RELIEF_DURATION, and SUBSCRIBER_ID_VERIFY.`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: 'You are an OCR/transcription engine. You can read images. Return ONLY the extracted text/fields from the document. Do not provide guidance, commentary, or refusal text. If something is unreadable, write [illegible].',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: base64Data,
              },
            },
            {
              type: 'text',
              text: ocrPrompt,
            },
          ],
        },
      ],
    });

    const extractedText = response.content[0]?.type === 'text'
      ? response.content[0].text
      : '';

    console.log(`✅ Extracted from ${isPDF ? `page ${pageNumber}` : 'image'} (${extractedText.length} chars)`);

    return res.json({ text: extractedText });

  } catch (err) {
    console.error('OCR error:', err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Unknown error occurred',
    });
  }
});

app.listen(PORT, () => {
  console.log(`MNR API server running on port ${PORT}`);
  console.log(`Model: claude-sonnet-4-6`);
});
