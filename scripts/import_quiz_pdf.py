import argparse
import json
import os
import re
import sys

import fitz


QUESTION_PATTERN = re.compile(r"^(\d{2})\.\s+(.*)")
SKIP_PATTERNS = [
    "Set Domande:",
    "SCIENZE BIOLOGICHE",
    "Docente:",
    "©",
    "Data Stampa",
    "Lezione",
]


def sanitize_file_part(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9]+", "_", value).strip("_").lower()
    return cleaned or "materia"


def should_skip_text(text: str) -> bool:
    return not text or any(pattern in text for pattern in SKIP_PATTERNS)


def extract_questions(pdf_path: str, images_dir: str, images_relative_dir: str, image_prefix: str):
    os.makedirs(images_dir, exist_ok=True)

    doc = fitz.open(pdf_path)
    extracted_questions = []
    current_question = None
    saved_images = 0

    for page in doc:
        blocks = page.get_text("blocks")

        for block in blocks:
            block_type = block[6]
            y0 = block[1]

            if block_type != 0:
                continue

            text = block[4].strip()
            if should_skip_text(text):
                continue

            question_match = QUESTION_PATTERN.match(text)
            if question_match:
                if current_question:
                    extracted_questions.append(current_question)

                number = question_match.group(1)
                question_text = question_match.group(2)
                text_parts = [part.strip() for part in text.split("\n") if part.strip()]

                if len(text_parts) > 1:
                    question_text = " ".join(text_parts).replace(f"{number}. ", "", 1).strip()

                current_question = {
                    "numero": number,
                    "testo": question_text,
                    "risposte": [],
                    "immagine_path": None,
                    "y0_domanda": y0,
                    "pagina": page.number,
                }
                continue

            if current_question:
                answers = [line.strip() for line in text.split("\n") if line.strip()]
                current_question["risposte"].extend(answers)

        page_questions = [
            question
            for question in extracted_questions + ([current_question] if current_question else [])
            if question.get("pagina") == page.number
        ]

        images_info = page.get_image_info(xrefs=True)
        for image_info in images_info:
            if image_info["width"] <= 50 or image_info["height"] <= 50:
                continue

            y0_image = image_info["bbox"][1]

            for index, question in enumerate(page_questions):
                y_current = question["y0_domanda"]
                y_next = page_questions[index + 1]["y0_domanda"] if index + 1 < len(page_questions) else 9999

                if not (y_current < y0_image < y_next):
                    continue

                xref = image_info["xref"]
                if xref == 0:
                    continue

                try:
                    base_image = doc.extract_image(xref)
                    if not base_image:
                        continue

                    extension = base_image.get("ext", "png")
                    file_name = f"{image_prefix}_pag{page.number}_dom{question['numero']}.{extension}"
                    absolute_path = os.path.join(images_dir, file_name)

                    with open(absolute_path, "wb") as image_file:
                        image_file.write(base_image["image"])

                    question["immagine_path"] = f"{images_relative_dir}/{file_name}".replace("\\", "/")
                    saved_images += 1
                    break
                except ValueError:
                    print(
                        f"Immagine corrotta ignorata (xref {xref}) a pagina {page.number}",
                        file=sys.stderr,
                    )
                    continue

    if current_question:
        extracted_questions.append(current_question)

    return extracted_questions, saved_images


def main():
    parser = argparse.ArgumentParser(description="Estrae quiz da un PDF in formato JSON.")
    parser.add_argument("--input", required=True, help="Percorso del PDF da elaborare.")
    parser.add_argument("--subject", required=True, help="Titolo della materia.")
    parser.add_argument("--images-dir", required=True, help="Cartella assoluta dove salvare le immagini.")
    parser.add_argument(
        "--images-relative-dir",
        default="immagini_quiz",
        help="Percorso relativo da salvare nel JSON per le immagini.",
    )
    parser.add_argument(
        "--image-prefix",
        default="materia",
        help="Prefisso usato per i nomi file delle immagini estratte.",
    )
    args = parser.parse_args()

    questions, saved_images = extract_questions(
        pdf_path=args.input,
        images_dir=args.images_dir,
        images_relative_dir=args.images_relative_dir,
        image_prefix=sanitize_file_part(args.image_prefix),
    )

    for question in questions:
        question["materia"] = args.subject.strip()

    payload = {
        "questions": questions,
        "stats": {
            "subject": args.subject.strip(),
            "extracted_questions": len(questions),
            "saved_images": saved_images,
        },
    }

    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
