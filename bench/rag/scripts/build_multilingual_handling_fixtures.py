"""Author the fixed fictional half of the multilingual handling diagnostic."""

import json
import unicodedata
from pathlib import Path

LOCALES = {
    "en": {
        "topics": [
            "Specimen storage",
            "Equipment inspection",
            "Library loans",
            "Battery charging",
            "Seminar enrollment",
            "Parcel transport",
            "Document scanning",
            "Data backup",
        ],
        "subjects": [
            "small blue container",
            "large red container",
            "medium red container",
            "small orange container",
            "small red container",
            "small pink container",
            "large blue container",
            "flat red container",
            "medium green container",
        ],
        "para": "the little container bearing a red label",
        "body": "Training record {code}. {topic}. This procedure applies to the {subject}. The prescribed waiting time is {value} minutes. Use the entry for this size and label colour; other entries have different times. The record number is {number}.",
        "semantic": "In {topic}, how many minutes should the {subject} wait?",
        "paraphrase": "For {topic}, what delay is prescribed for {para}?",
        "locator": "Find the {topic} training record numbered {code} and its waiting time.",
        "orthographic": "{topic} {code}",
    },
    "ja": {
        "topics": [
            "試料保管",
            "機器点検",
            "図書貸出",
            "電池充電",
            "講座受付",
            "荷物輸送",
            "文書スキャン",
            "データバックアップ",
        ],
        "subjects": [
            "青ラベルの小型容器",
            "赤ラベルの大型容器",
            "赤ラベルの中型容器",
            "橙ラベルの小型容器",
            "赤ラベルの小型容器",
            "桃色ラベルの小型容器",
            "青ラベルの大型容器",
            "赤ラベルの薄型容器",
            "緑ラベルの中型容器",
        ],
        "para": "赤い札が付いた小さな容器",
        "body": "研修作業票{code}。{topic}。対象は{subject}です。規定の待ち時間は{value}分です。大きさとラベルの色に対応する作業票を使ってください。他の作業票では待ち時間が異なります。記録番号は{number}です。",
        "semantic": "{topic}で{subject}を扱うとき、何分待つ決まりですか。",
        "paraphrase": "{topic}について、{para}に定められた待機時間を教えてください。",
        "locator": "{topic}の研修資料から作業票{code}を探し、指定の待ち時間を確認してください。",
        "orthographic": "{topic} {code}",
    },
    "ko": {
        "topics": [
            "시료 보관",
            "장비 점검",
            "도서 대출",
            "배터리 충전",
            "강좌 접수",
            "소포 운송",
            "문서 스캔",
            "데이터 백업",
        ],
        "subjects": [
            "파란 표지의 소형 용기",
            "빨간 표지의 대형 용기",
            "빨간 표지의 중형 용기",
            "주황 표지의 소형 용기",
            "빨간 표지의 소형 용기",
            "분홍 표지의 소형 용기",
            "파란 표지의 대형 용기",
            "빨간 표지의 납작한 용기",
            "초록 표지의 중형 용기",
        ],
        "para": "붉은 딱지가 붙은 작은 용기",
        "body": "교육 작업표 {code}. {topic}. 이 절차의 대상은 {subject}입니다. 정해진 대기 시간은 {value}분입니다. 크기와 표지 색상에 맞는 작업표를 사용해야 합니다. 다른 작업표의 대기 시간은 다릅니다. 기록 번호는 {number}입니다.",
        "semantic": "{topic}에서 {subject}는 몇 분 동안 기다려야 하나요?",
        "paraphrase": "{topic} 절차에서 {para}에 지정된 대기 시간을 알려 주세요.",
        "locator": "{topic} 교육 자료에서 작업표 {code}를 찾아 대기 시간을 확인해 주세요.",
        "orthographic": "{topic} {code}",
    },
    "zh-CN": {
        "topics": [
            "样本储存",
            "设备检查",
            "图书借阅",
            "电池充电",
            "课程报名",
            "包裹运输",
            "文档扫描",
            "数据备份",
        ],
        "subjects": [
            "蓝标小号容器",
            "红标大号容器",
            "红标中号容器",
            "橙标小号容器",
            "红标小号容器",
            "粉标小号容器",
            "蓝标大号容器",
            "红标扁平容器",
            "绿标中号容器",
        ],
        "para": "贴着红色标签的小容器",
        "body": "培训操作单{code}。{topic}。本流程适用于{subject}。规定等待时间为{value}分钟。请按尺寸和标签颜色选择操作单，其他操作单的时间不同。记录编号为{number}。电子记录由教学软件保存。",
        "semantic": "进行{topic}时，{subject}需要等待多少分钟？",
        "paraphrase": "在{topic}流程中，{para}规定要等多久？",
        "locator": "请在{topic}培训资料里查找编号{code}的操作单，确认等待时间。",
        "orthographic": "{topic} {code}",
    },
    "zh-TW": {
        "topics": [
            "樣本儲存",
            "設備檢查",
            "圖書借閱",
            "電池充電",
            "課程報名",
            "包裹運送",
            "文件掃描",
            "資料備份",
        ],
        "subjects": [
            "藍標小型容器",
            "紅標大型容器",
            "紅標中型容器",
            "橘標小型容器",
            "紅標小型容器",
            "粉紅標小型容器",
            "藍標大型容器",
            "紅標扁平容器",
            "綠標中型容器",
        ],
        "para": "貼著紅色標籤的小容器",
        "body": "研習操作單{code}。{topic}。本流程適用於{subject}。規定等候時間為{value}分鐘。請依尺寸及標籤顏色選擇操作單，其他操作單的時間不同。紀錄編號為{number}。電子紀錄由教學軟體儲存在隨身碟。",
        "semantic": "進行{topic}時，{subject}需要等候幾分鐘？",
        "paraphrase": "在{topic}流程中，{para}規定要等多久？請依軟件裏的紀錄回答。",
        "locator": "請在{topic}研習資料中找到編號{code}的操作單，確認等候時間。",
        "orthographic": "{topic} {code}",
    },
    "zh-HK": {
        "topics": [
            "樣本貯存",
            "器材檢查",
            "圖書借閱",
            "電池充電",
            "課程報名",
            "包裹運輸",
            "文件掃描",
            "數據備份",
        ],
        "subjects": [
            "藍標細容器",
            "紅標大容器",
            "紅標中型容器",
            "橙標細容器",
            "紅標細容器",
            "粉紅標細容器",
            "藍標大容器",
            "紅標扁平容器",
            "綠標中型容器",
        ],
        "para": "貼住紅色標籤嘅細容器",
        "body": "培訓工序表{code}。{topic}。本流程適用於{subject}。指定輪候時間是{value}分鐘。請按大小及標籤顏色選擇工序表，其他工序表的時間不同。紀錄編號為{number}。電子紀錄由教學軟件儲存在USB手指。",
        "semantic": "處理{topic}時，{subject}要輪候幾多分鐘？",
        "paraphrase": "做{topic}嗰陣，{para}要等幾耐？請睇軟件入面嘅紀錄。",
        "locator": "請在{topic}培訓資料中找出編號{code}的工序表，確認輪候時間。",
        "orthographic": "{topic} {code}",
    },
    "es": {
        "topics": [
            "Almacenamiento de muestras",
            "Inspección de equipos",
            "Préstamos de biblioteca",
            "Carga de baterías",
            "Inscripción en cursos",
            "Transporte de paquetes",
            "Digitalización de documentos",
            "Copias de seguridad de datos",
        ],
        "subjects": [
            "recipiente pequeño de etiqueta azul",
            "recipiente grande de etiqueta roja",
            "recipiente mediano de etiqueta roja",
            "recipiente pequeño de etiqueta naranja",
            "recipiente pequeño de etiqueta roja",
            "recipiente pequeño de etiqueta rosa",
            "recipiente grande de etiqueta azul",
            "recipiente plano de etiqueta roja",
            "recipiente mediano de etiqueta verde",
        ],
        "para": "el envase de tamaño reducido que lleva una etiqueta roja",
        "body": "Ficha de formación {code}. {topic}. Este procedimiento se aplica al {subject}. El tiempo de espera prescrito es de {value} minutos. Hay que elegir la ficha según el tamaño y el color de la etiqueta; las demás fichas indican otros tiempos. El número de registro es {number}.",
        "semantic": "En {topic}, ¿cuántos minutos debe esperar el {subject}?",
        "paraphrase": "Para {topic}, ¿qué demora se establece para {para}?",
        "locator": "Busca la ficha {code} en el material de formación sobre {topic} e indica el tiempo de espera.",
        "orthographic": "{topic} {code}",
    },
    "fr": {
        "topics": [
            "Stockage des échantillons",
            "Inspection du matériel",
            "Prêts de bibliothèque",
            "Recharge des batteries",
            "Inscription aux cours",
            "Transport des colis",
            "Numérisation des documents",
            "Sauvegarde des données",
        ],
        "subjects": [
            "petit récipient à étiquette bleue",
            "grand récipient à étiquette rouge",
            "récipient moyen à étiquette rouge",
            "petit récipient à étiquette orange",
            "petit récipient à étiquette rouge",
            "petit récipient à étiquette rose",
            "grand récipient à étiquette bleue",
            "récipient plat à étiquette rouge",
            "récipient moyen à étiquette verte",
        ],
        "para": "le contenant de petite taille portant une étiquette rouge",
        "body": "Fiche de formation {code}. {topic}. Cette procédure concerne le {subject}. Le délai d'attente prescrit est de {value} minutes. Il faut choisir la fiche selon la taille et la couleur de l'étiquette; les autres fiches indiquent des délais différents. Le numéro du registre est {number}.",
        "semantic": "Pour {topic}, combien de minutes le {subject} doit-il attendre ?",
        "paraphrase": "Dans la procédure de {topic}, quel délai est prévu pour {para} ?",
        "locator": "Retrouve la fiche {code} dans les documents de formation sur {topic} et indique le délai d'attente.",
        "orthographic": "{topic} {code}",
    },
}


def build():
    from opencc import OpenCC

    simplified = OpenCC("t2s")
    documents, queries = [], []
    for locale, spec in LOCALES.items():
        for family, topic in enumerate(spec["topics"]):
            split = "dev" if family < 4 else "heldout"
            for variant, subject in enumerate(spec["subjects"]):
                code = f"{['MX', 'RV', 'LK', 'BT', 'SC', 'PX', 'DS', 'BK'][family]}-{317 + 43 * variant}"
                docid = f"controlled-{locale}-{family}-{variant}"
                fields = {
                    "topic": topic,
                    "code": code,
                    "subject": subject,
                    "para": spec["para"],
                    "value": 11 + 7 * family + 3 * variant,
                    "number": 17 + family * 11 + variant,
                }
                documents.append(
                    {
                        "id": docid,
                        "locale": locale,
                        "family": family,
                        "split": split,
                        "title": f"{topic} · {code}",
                        "text": spec["body"].format(**fields),
                    }
                )
                if variant != 4:
                    continue
                texts = {
                    "semantic": spec["semantic"].format(**fields),
                    "paraphrase": spec["paraphrase"].format(**fields),
                    "identifier": code,
                    "contextual_locator": spec["locator"].format(**fields),
                    "orthographic": spec["orthographic"].format(**fields),
                    "cross_language": f"In {LOCALES['en']['topics'][family]}, how many minutes should the small red container wait?",
                }
                if locale == "en":
                    texts["cross_language"] = (
                        f"在{LOCALES['zh-CN']['topics'][family]}流程中，红标小号容器需要等待多少分钟？"
                    )
                texts["orthographic"] = "".join(
                    chr(ord(c) + 0xFEE0) if c.isascii() and c.isalnum() else c
                    for c in texts["orthographic"]
                )
                if locale.startswith("zh-"):
                    texts["orthographic"] = simplified.convert(texts["orthographic"])
                if locale in {"es", "fr"}:
                    texts["orthographic"] = unicodedata.normalize(
                        "NFD", texts["orthographic"]
                    )
                if locale == "ko":
                    texts["orthographic"] = unicodedata.normalize(
                        "NFD", texts["orthographic"]
                    )
                for kind, text in texts.items():
                    queries.append(
                        {
                            "id": f"{docid}-{kind}",
                            "locale": locale,
                            "family": f"controlled-{family}",
                            "split": split,
                            "kind": kind,
                            "q": text,
                            "qrels": {docid: 1},
                        }
                    )
    assert len(documents) == 576 and len(queries) == 384
    return {
        "schema": "capy-multilingual-handling-v1",
        "provenance": "Fictional parallel training records and queries authored by Codex, not native-speaker-certified. This controlled diagnostic does not describe real operational procedures.",
        "documents": documents,
        "queries": queries,
    }


if __name__ == "__main__":
    path = (
        Path(__file__).resolve().parents[1]
        / "fixtures/multilingual-language-handling.json"
    )
    path.write_text(json.dumps(build(), ensure_ascii=False, indent=2) + "\n")
    print(path)
