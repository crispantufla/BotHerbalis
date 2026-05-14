"""
Genera un PDF de comparación V5 vs V6 del guion del bot de WhatsApp Herbalis.
Output: docs/V5_vs_V6_comparison.pdf
"""
import json
import os
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm, mm
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
    PageBreak,
    KeepTogether,
)

ROOT = Path(__file__).resolve().parents[1]
V5 = json.load(open(ROOT / "knowledge_v5.json", encoding="utf-8"))
V6 = json.load(open(ROOT / "knowledge_v6.json", encoding="utf-8"))

OUT = ROOT / "docs" / "V5_vs_V6_comparison.pdf"
OUT.parent.mkdir(parents=True, exist_ok=True)

GREEN = colors.HexColor("#3F7D58")
GREEN_DARK = colors.HexColor("#2A5A3D")
GREEN_LIGHT = colors.HexColor("#E8F2EC")
GREY_TXT = colors.HexColor("#333333")
GREY_SOFT = colors.HexColor("#777777")
DIVIDER = colors.HexColor("#D8E2DC")
V5_BG = colors.HexColor("#F5F5F2")
V6_BG = colors.HexColor("#EEF7F0")
ACCENT_AMBER = colors.HexColor("#C68E17")

styles = getSampleStyleSheet()

title_style = ParagraphStyle(
    "Title", parent=styles["Title"], fontName="Helvetica-Bold",
    fontSize=22, leading=26, textColor=GREEN_DARK, alignment=0, spaceAfter=4,
)
subtitle_style = ParagraphStyle(
    "Subtitle", parent=styles["Normal"], fontName="Helvetica",
    fontSize=10.5, leading=14, textColor=GREY_SOFT, spaceAfter=14,
)
section_style = ParagraphStyle(
    "Section", parent=styles["Heading2"], fontName="Helvetica-Bold",
    fontSize=13, leading=16, textColor=GREEN_DARK, spaceBefore=14, spaceAfter=6,
)
sub_section = ParagraphStyle(
    "SubSection", parent=styles["Heading3"], fontName="Helvetica-Bold",
    fontSize=10.5, leading=13, textColor=GREEN, spaceBefore=8, spaceAfter=3,
)
body = ParagraphStyle(
    "Body", parent=styles["Normal"], fontName="Helvetica",
    fontSize=9.5, leading=13, textColor=GREY_TXT, spaceAfter=4,
)
body_small = ParagraphStyle(
    "BodySmall", parent=styles["Normal"], fontName="Helvetica",
    fontSize=8.5, leading=11.5, textColor=GREY_TXT,
)
quote_v5 = ParagraphStyle(
    "QuoteV5", parent=body_small, fontName="Helvetica",
    leftIndent=4, rightIndent=4, textColor=GREY_TXT,
)
quote_v6 = ParagraphStyle(
    "QuoteV6", parent=body_small, fontName="Helvetica",
    leftIndent=4, rightIndent=4, textColor=GREEN_DARK,
)
label_v5 = ParagraphStyle(
    "LabelV5", parent=body, fontName="Helvetica-Bold",
    fontSize=9, leading=11, textColor=GREY_SOFT, spaceAfter=2,
)
label_v6 = ParagraphStyle(
    "LabelV6", parent=body, fontName="Helvetica-Bold",
    fontSize=9, leading=11, textColor=GREEN_DARK, spaceAfter=2,
)
foot = ParagraphStyle(
    "Foot", parent=styles["Normal"], fontName="Helvetica",
    fontSize=8, leading=10, textColor=GREY_SOFT, alignment=2,
)


def whatsapp_to_html(txt: str) -> str:
    """Convierte *negrita* WhatsApp a <b>negrita</b> y escapa <>&."""
    import re
    txt = txt.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    txt = re.sub(r"\*([^*\n]+)\*", r"<b>\1</b>", txt)
    txt = txt.replace("\n", "<br/>")
    return txt


def comparison_row(label: str, v5_text: str, v6_text: str) -> Table:
    cells = [
        [Paragraph(label, sub_section), ""],
        [
            [Paragraph("V5", label_v5), Paragraph(whatsapp_to_html(v5_text), quote_v5)],
            [Paragraph("V6", label_v6), Paragraph(whatsapp_to_html(v6_text), quote_v6)],
        ],
    ]
    t = Table(
        [cells[0], cells[1]],
        colWidths=[8.5 * cm, 8.5 * cm],
    )
    t.setStyle(
        TableStyle([
            ("SPAN", (0, 0), (1, 0)),
            ("BACKGROUND", (0, 1), (0, 1), V5_BG),
            ("BACKGROUND", (1, 1), (1, 1), V6_BG),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 8),
            ("RIGHTPADDING", (0, 0), (-1, -1), 8),
            ("TOPPADDING", (0, 1), (-1, 1), 8),
            ("BOTTOMPADDING", (0, 1), (-1, 1), 8),
            ("BOX", (0, 1), (0, 1), 0.4, DIVIDER),
            ("BOX", (1, 1), (1, 1), 0.4, GREEN),
        ])
    )
    return t


def header_footer(canvas, doc):
    canvas.saveState()
    w, h = A4
    # Top green band
    canvas.setFillColor(GREEN_DARK)
    canvas.rect(0, h - 1.2 * cm, w, 1.2 * cm, fill=1, stroke=0)
    canvas.setFillColor(colors.white)
    canvas.setFont("Helvetica-Bold", 10)
    canvas.drawString(2 * cm, h - 0.78 * cm, "HERBALIS · BOT WHATSAPP")
    canvas.setFont("Helvetica", 9)
    canvas.drawRightString(w - 2 * cm, h - 0.78 * cm, "V5 vs V6 — comparativa de guion")
    # Footer
    canvas.setFillColor(GREY_SOFT)
    canvas.setFont("Helvetica", 8)
    canvas.drawString(2 * cm, 1.0 * cm, "Generado el 2026-05-14 · commit 8d68139")
    canvas.drawRightString(w - 2 * cm, 1.0 * cm, f"Pág. {doc.page}")
    canvas.restoreState()


def build():
    doc = BaseDocTemplate(
        str(OUT), pagesize=A4,
        leftMargin=2 * cm, rightMargin=2 * cm,
        topMargin=1.8 * cm, bottomMargin=1.6 * cm,
        title="Herbalis — V5 vs V6 comparativa",
        author="Bot Herbalis",
    )
    frame = Frame(
        doc.leftMargin, doc.bottomMargin,
        doc.width, doc.height, id="main", showBoundary=0,
    )
    doc.addPageTemplates([PageTemplate(id="main", frames=[frame], onPage=header_footer)])

    story = []

    # ----- COVER -----
    story.append(Spacer(1, 0.4 * cm))
    story.append(Paragraph("V5 vs V6", title_style))
    story.append(Paragraph(
        f"Comparativa de los dos guiones activos del bot de WhatsApp Herbalis. "
        f"V5 ({V5['meta']['version']}): {V5['meta']['name']}. "
        f"V6 ({V6['meta']['version']}): {V6['meta']['name']}.",
        subtitle_style,
    ))

    # ----- RESUMEN -----
    story.append(Paragraph("Resumen ejecutivo", section_style))
    story.append(Paragraph(
        "Misma arquitectura de funnel y misma política de pago en ambos guiones. "
        "V5 mantiene un tono <b>asesor consultivo</b> directo. V6 (rebautizado 6.1 tras "
        "la pasada de venta consultiva del 14/05/2026) suma <b>persuasión calibrada</b>: "
        "anclaje de valor con precio/día, marcos temporales explícitos en las "
        "recomendaciones, refuerzo del commitment post-elección, y FAQs reforzadas con "
        "risk reversal concreto (no falsa escasez, no garantías infladas).",
        body,
    ))

    # Quick stats table
    flow_v5 = list(V5["flow"].keys())
    flow_v6 = list(V6["flow"].keys())
    stats = [
        ["", "V5", "V6"],
        ["Versión", V5["meta"]["version"], V6["meta"]["version"]],
        ["Persona", "Asesor (neutral)", "Elena (charla cálida)"],
        ["Entradas flow", str(len(flow_v5)), str(len(flow_v6))],
        ["FAQs", str(len(V5["faq"])), str(len(V6["faq"]))],
        ["Política de pago", "3 opciones espontáneas", "3 opciones espontáneas"],
        ["Alias bancario", V5["rules"]["bankAlias"]["alias"], V6["rules"]["bankAlias"]["alias"]],
        ["Anticipo COD", "$10.000 (transf. o MP)", "$10.000 (transf. o MP)"],
        ["Anchor precio/día", "—", "${{PRICE_PER_DAY_120}}/día"],
    ]
    t = Table(stats, colWidths=[5.5 * cm, 5.7 * cm, 5.8 * cm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), GREEN_DARK),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, GREEN_LIGHT]),
        ("GRID", (0, 0), (-1, -1), 0.3, DIVIDER),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("FONTNAME", (0, 1), (0, -1), "Helvetica-Bold"),
    ]))
    story.append(Spacer(1, 0.3 * cm))
    story.append(t)

    # ----- CAMBIOS CLAVE -----
    story.append(Paragraph("Cambios clave aplicados en V6.1", section_style))
    bullets = [
        ("Anclaje de valor", "El precio del plan 4 meses se acompaña ahora del costo diario "
         "(<b>${{PRICE_PER_DAY_120}}/día — menos que un café ☕</b>). Mismo precio total, "
         "shock percibido más bajo."),
        ("Marco temporal explícito", "Las recomendaciones ahora dicen <i>en esos 2 meses</i> "
         "o <i>en los 4 meses</i>. Antes el cliente llenaba el silencio con ansiedad."),
        ("Gradiente realista", "<i>1 a 1,5 kilos por semana — ritmo sostenible y sin rebote</i>. "
         "Frente preemptivo a la objeción top del nicho."),
        ("Refuerzo de commitment", "El closing arranca con <i>¡Buenísima decisión!</i> "
         "(efecto consistencia, Cialdini)."),
        ("Risk reversal concreto", "FAQ <i>estafa</i> ahora cierra con: <i>si nunca te llega, "
         "no perdiste el total</i>. Pone al pago contra-reembolso como salvavidas explícito."),
        ("Price-lock honesto", "FAQ <i>no tengo / cobro</i> ya no solo programa el envío — "
         "ahora dice <i>te dejo el precio congelado de hoy</i>. Incentivo concreto en "
         "contexto Argentina."),
        ("Cross-sell mantenimiento", "Tanto en recommendation_3 como en FAQ rebote: "
         "<i>1-2 por semana como mantenimiento, así no vuelven los kilos</i>. "
         "Reduce el miedo al rebote y anuncia upsell futuro."),
        ("Tono mantenido", "Sigue siendo Elena. Nada de scarcity falsa, ni promesas "
         "garantizadas, ni presión de urgencia."),
    ]
    for label, text in bullets:
        story.append(Paragraph(f"<b>{label}.</b> {text}", body))

    # ----- COMPARATIVAS LADO A LADO -----
    story.append(PageBreak())
    story.append(Paragraph("Comparativa lado a lado", section_style))
    story.append(Paragraph(
        "Las celdas grises muestran V5 (referencia consultiva). Las verdes muestran V6.1 "
        "(con persuasión calibrada). Los placeholders <b>{{PRICE_60}}</b>, "
        "<b>{{PRICE_120}}</b> y <b>{{PRICE_PER_DAY_120}}</b> se resuelven en runtime según "
        "el producto seleccionado.",
        body,
    ))
    story.append(Spacer(1, 0.2 * cm))

    pairs = [
        ("Greeting", V5["flow"]["greeting"]["response"], V6["flow"]["greeting"]["response"]),
        ("Recommendation tier 1 (hasta 10 kg)",
         V5["flow"]["recommendation_1"]["response"],
         V6["flow"]["recommendation_1"]["response"]),
        ("Recommendation tier 2 (10 a 20 kg)",
         V5["flow"]["recommendation_2"]["response"],
         V6["flow"]["recommendation_2"]["response"]),
        ("Recommendation tier 3 (+20 kg)",
         V5["flow"]["recommendation_3"]["response"],
         V6["flow"]["recommendation_3"]["response"]),
        ("Prices (TEXTO 3) — el cambio más impactante",
         V5["flow"]["prices"]["response"],
         V6["flow"]["prices"]["response"]),
        ("Closing (pedido de datos)",
         V5["flow"]["closing"]["response"],
         V6["flow"]["closing"]["response"]),
    ]
    for label, a, b in pairs:
        story.append(KeepTogether(comparison_row(label, a, b)))
        story.append(Spacer(1, 0.25 * cm))

    # ----- FAQ COMPARATIVAS -----
    story.append(PageBreak())
    story.append(Paragraph("FAQs reforzadas", section_style))
    story.append(Paragraph(
        "Las objeciones críticas (precio, rebote, fraude) son las que V6.1 ataca con más "
        "fuerza. El resto de FAQs se mantienen similares.",
        body,
    ))
    story.append(Spacer(1, 0.2 * cm))

    def find_faq(guion, key):
        for f in guion["faq"]:
            if any(key in k for k in f.get("keywords", [])):
                return f["response"]
        return ""

    faq_pairs = [
        ('FAQ "muy caro"', "caro"),
        ('FAQ "rebote"', "rebote"),
        ('FAQ "estafa / es seguro"', "estafa"),
        ('FAQ "no tengo / cobro tal día"', "cobro"),
        ('FAQ "cómo se toma"', "como se toma"),
    ]
    for label, key in faq_pairs:
        v5_resp = find_faq(V5, key)
        v6_resp = find_faq(V6, key)
        story.append(KeepTogether(comparison_row(label, v5_resp, v6_resp)))
        story.append(Spacer(1, 0.25 * cm))

    # ----- CIERRE -----
    story.append(PageBreak())
    story.append(Paragraph("Cuándo usar cada uno", section_style))
    story.append(Paragraph(
        "<b>V5 — Asesor consultivo.</b> Tono profesional, directo, sin floritura. "
        "Recomendado cuando el público responde mejor a comunicación seca y clara, o "
        "cuando se quiere mantener una baseline de control en un test A/B.",
        body,
    ))
    story.append(Paragraph(
        "<b>V6.1 — Elena charla (sales-tuned).</b> Tono cálido, con persuasión "
        "calibrada (anclaje de valor, marcos temporales, risk reversal explícito). "
        "Recomendado como guion principal — mantiene la honestidad de V5 pero con "
        "argumentos de venta más maduros frente a las objeciones top del nicho.",
        body,
    ))
    story.append(Spacer(1, 0.3 * cm))
    story.append(Paragraph(
        "Ambos guiones comparten la misma política de pago (3 opciones espontáneas: "
        "Mercado Pago, transferencia al alias <b>HERBALIS.TIENDA</b> a nombre de "
        "<b>BIO ORIGEN S.A.S.</b>, o contra reembolso con anticipo de $10.000) y la "
        "misma infraestructura de placeholders defensivos contra leaks.",
        body,
    ))

    doc.build(story)
    print(f"OK -> {OUT}")


if __name__ == "__main__":
    build()
