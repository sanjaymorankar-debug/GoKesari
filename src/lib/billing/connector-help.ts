/**
 * Step-by-step guides for moving books between GoKesari and each accounting
 * software (billing v2, docs/billing §8), in English, Hindi and Marathi. Pure
 * data, shown at /help/connectors/<tool>. Menu paths are those of the
 * software's current versions as of Nov 2026; a guide says so where a step
 * depends on the version.
 */
import { L, type Text } from "@/lib/board/i18n";

export interface ConnectorGuide {
  key: string;
  name: string;
  /** Files GoKesari sends. */
  sends: Text;
  toSoftware: Text[];
  fromSoftware: Text[];
  note?: Text;
}

const OPEN_SYNC = L("In GoKesari: Accounts → Sync with Tally, Zoho… → choose the dates.", "GoKesari में: हिसाब → Tally, Zoho… से सिंक → तारीख़ें चुनें।", "GoKesari मध्ये: हिशेब → Tally, Zoho… सोबत सिंक → तारखा निवडा.");
const BRING_IN = L("In GoKesari: Sync → Bring in a file → choose the file. New parties and items are added first, then the vouchers. Anything changed on both sides waits under 'Changed on both sides' for you to decide.", "GoKesari में: सिंक → फ़ाइल लाएँ → फ़ाइल चुनें। पहले नए पार्टी और आइटम जुड़ते हैं, फिर वाउचर। जो दोनों तरफ़ बदला है वह 'दोनों तरफ़ बदला' में आपके फ़ैसले का इंतज़ार करता है।", "GoKesari मध्ये: सिंक → फाइल आणा → फाइल निवडा. आधी नवीन पक्षकार आणि आयटम जोडले जातात, मग व्हाउचर. दोन्ही बाजूंनी बदललेले 'दोन्ही बाजूंनी बदलले' मध्ये तुमच्या निर्णयाची वाट पाहते.");

export const CONNECTOR_GUIDES: Record<string, ConnectorGuide> = {
  tally: {
    key: "tally",
    name: "TallyPrime",
    sends: L("A ZIP with gokesari-tally.xml (masters + vouchers), gokesari-tally.xlsx and the Excel mapping file.", "एक ZIP: gokesari-tally.xml (मास्टर + वाउचर), gokesari-tally.xlsx और Excel मैपिंग फ़ाइल।", "एक ZIP: gokesari-tally.xml (मास्टर + व्हाउचर), gokesari-tally.xlsx आणि Excel मॅपिंग फाइल."),
    toSoftware: [
      OPEN_SYNC,
      L("Under TallyPrime press 'Send to software' and unzip the file.", "TallyPrime के नीचे 'सॉफ़्टवेयर को भेजें' दबाएँ और ZIP खोलें।", "TallyPrime खाली 'सॉफ्टवेअरला पाठवा' दाबा आणि ZIP उघडा."),
      L("In TallyPrime open the company, then Gateway of Tally → Import → Masters → choose gokesari-tally.xml → 'Modify with new data'.", "TallyPrime में कंपनी खोलें, फिर Gateway of Tally → Import → Masters → gokesari-tally.xml चुनें → 'Modify with new data'।", "TallyPrime मध्ये कंपनी उघडा, मग Gateway of Tally → Import → Masters → gokesari-tally.xml निवडा → 'Modify with new data'."),
      L("Then Import → Transactions → the same file. Vouchers keep GoKesari's numbers; importing the same file again updates them, it does not duplicate.", "फिर Import → Transactions → वही फ़ाइल। वाउचर GoKesari के नंबर रखते हैं; वही फ़ाइल दोबारा लाने पर वे अपडेट होते हैं, दोहराए नहीं जाते।", "मग Import → Transactions → तीच फाइल. व्हाउचर GoKesari चे क्रमांक ठेवतात; तीच फाइल पुन्हा आणल्यास ते अद्ययावत होतात, दुबार होत नाहीत."),
      L("Prefer Excel? Import → Masters / Transactions → Excel, choose gokesari-tally.xlsx and load the mapping file gokesari-tally-mapping.tsf (check the column map on your Tally version).", "Excel चाहिए? Import → Masters / Transactions → Excel, gokesari-tally.xlsx चुनें और मैपिंग फ़ाइल gokesari-tally-mapping.tsf लोड करें (अपने Tally संस्करण पर कॉलम मैप जाँचें)।", "Excel हवे? Import → Masters / Transactions → Excel, gokesari-tally.xlsx निवडा आणि मॅपिंग फाइल gokesari-tally-mapping.tsf लोड करा (तुमच्या Tally आवृत्तीवर कॉलम मॅप तपासा)."),
    ],
    fromSoftware: [
      L("In TallyPrime: Display More Reports → Day Book (or List of Accounts for masters) → Export → XML (data interchange) → File.", "TallyPrime में: Display More Reports → Day Book (मास्टर के लिए List of Accounts) → Export → XML (data interchange) → File।", "TallyPrime मध्ये: Display More Reports → Day Book (मास्टरसाठी List of Accounts) → Export → XML (data interchange) → File."),
      BRING_IN,
    ],
    note: L("For automatic two-way sync, install the GoKesari Tally Connector on the computer where Tally runs (Sync → Tally → Connector).", "अपने-आप दोनों तरफ़ सिंक के लिए, जिस कंप्यूटर पर Tally चलता है उस पर GoKesari Tally Connector लगाएँ।", "आपोआप दोन्ही बाजूंनी सिंकसाठी, ज्या संगणकावर Tally चालते त्यावर GoKesari Tally Connector बसवा."),
  },
  busy: {
    key: "busy",
    name: "Busy",
    sends: L("An Excel file with Account Master, Item Master and Vouchers sheets.", "Account Master, Item Master और Vouchers शीट वाली Excel फ़ाइल।", "Account Master, Item Master आणि Vouchers शीट असलेली Excel फाइल."),
    toSoftware: [
      OPEN_SYNC,
      L("Press 'Send to software' under Busy.", "Busy के नीचे 'सॉफ़्टवेयर को भेजें' दबाएँ।", "Busy खाली 'सॉफ्टवेअरला पाठवा' दाबा."),
      L("In Busy: Administration → Data Import/Export → Import Masters from Excel (Account and Item sheets), then Import Vouchers from Excel. Match the columns once and save the mapping.", "Busy में: Administration → Data Import/Export → Import Masters from Excel (Account और Item शीट), फिर Import Vouchers from Excel। एक बार कॉलम मिलाएँ और मैपिंग सेव करें।", "Busy मध्ये: Administration → Data Import/Export → Import Masters from Excel (Account आणि Item शीट), मग Import Vouchers from Excel. एकदा कॉलम जुळवा आणि मॅपिंग सेव्ह करा."),
    ],
    fromSoftware: [L("In Busy: Display → Account Books / Masters → Export to Excel.", "Busy में: Display → Account Books / Masters → Export to Excel।", "Busy मध्ये: Display → Account Books / Masters → Export to Excel."), BRING_IN],
    note: L("Busy has no public live connection; files are the supported way.", "Busy का कोई सार्वजनिक लाइव कनेक्शन नहीं है; फ़ाइलें ही तरीका हैं।", "Busy चे सार्वजनिक थेट कनेक्शन नाही; फाइल्स हाच मार्ग आहे."),
  },
  marg: {
    key: "marg",
    name: "Marg ERP",
    sends: L("A Busy-compatible Excel file: Ledger, Product and Bills sheets.", "Busy-जैसी Excel फ़ाइल: Ledger, Product और Bills शीट।", "Busy-सारखी Excel फाइल: Ledger, Product आणि Bills शीट."),
    toSoftware: [OPEN_SYNC, L("In Marg: Utilities → Import Data → From Excel; choose the sheet and match the columns.", "Marg में: Utilities → Import Data → From Excel; शीट चुनें और कॉलम मिलाएँ।", "Marg मध्ये: Utilities → Import Data → From Excel; शीट निवडा आणि कॉलम जुळवा.")],
    fromSoftware: [L("In Marg: reports → Export to Excel.", "Marg में: रिपोर्ट → Export to Excel।", "Marg मध्ये: अहवाल → Export to Excel."), BRING_IN],
  },
  vyapar: {
    key: "vyapar",
    name: "Vyapar",
    sends: L("An Excel file with Parties, Items and Transactions sheets.", "Parties, Items और Transactions शीट वाली Excel फ़ाइल।", "Parties, Items आणि Transactions शीट असलेली Excel फाइल."),
    toSoftware: [OPEN_SYNC, L("In Vyapar: Utilities → Import Items / Import Parties from Excel; choose the sheet.", "Vyapar में: Utilities → Import Items / Import Parties from Excel; शीट चुनें।", "Vyapar मध्ये: Utilities → Import Items / Import Parties from Excel; शीट निवडा.")],
    fromSoftware: [L("In Vyapar: Reports → the report → Excel.", "Vyapar में: Reports → रिपोर्ट → Excel।", "Vyapar मध्ये: Reports → अहवाल → Excel."), BRING_IN],
  },
  mybillbook: {
    key: "mybillbook",
    name: "myBillBook",
    sends: L("An Excel file with Parties, Items and Invoices sheets.", "Parties, Items और Invoices शीट वाली Excel फ़ाइल।", "Parties, Items आणि Invoices शीट असलेली Excel फाइल."),
    toSoftware: [OPEN_SYNC, L("In myBillBook: Items / Parties → Bulk upload → Excel; choose the sheet.", "myBillBook में: Items / Parties → Bulk upload → Excel; शीट चुनें।", "myBillBook मध्ये: Items / Parties → Bulk upload → Excel; शीट निवडा.")],
    fromSoftware: [L("In myBillBook: Reports → Download Excel.", "myBillBook में: Reports → Download Excel।", "myBillBook मध्ये: Reports → Download Excel."), BRING_IN],
  },
  zoho: {
    key: "zoho",
    name: "Zoho Books",
    sends: L("A ZIP of CSV files: contacts, items and transactions.", "CSV फ़ाइलों का ZIP: contacts, items और transactions।", "CSV फाइल्सचे ZIP: contacts, items आणि transactions."),
    toSoftware: [OPEN_SYNC, L("In Zoho Books: Contacts / Items / Invoices → ⋯ → Import → choose the CSV → map fields → Import.", "Zoho Books में: Contacts / Items / Invoices → ⋯ → Import → CSV चुनें → फ़ील्ड मिलाएँ → Import।", "Zoho Books मध्ये: Contacts / Items / Invoices → ⋯ → Import → CSV निवडा → फील्ड जुळवा → Import.")],
    fromSoftware: [L("In Zoho Books: the list → ⋯ → Export → CSV.", "Zoho Books में: सूची → ⋯ → Export → CSV।", "Zoho Books मध्ये: यादी → ⋯ → Export → CSV."), BRING_IN],
    note: L("Live sync: Settings → Integrations → Zoho Books → Connect (sign in to Zoho once).", "लाइव सिंक: Settings → Integrations → Zoho Books → Connect (एक बार Zoho में साइन इन)।", "थेट सिंक: Settings → Integrations → Zoho Books → Connect (एकदा Zoho मध्ये साइन इन)."),
  },
  odoo: {
    key: "odoo",
    name: "Odoo",
    sends: L("A ZIP of CSV files: res.partner, product.template and account.move.", "CSV फ़ाइलों का ZIP: res.partner, product.template और account.move।", "CSV फाइल्सचे ZIP: res.partner, product.template आणि account.move."),
    toSoftware: [OPEN_SYNC, L("In Odoo: the list view → ⚙ → Import records → choose the CSV → test → Import.", "Odoo में: list view → ⚙ → Import records → CSV चुनें → test → Import।", "Odoo मध्ये: list view → ⚙ → Import records → CSV निवडा → test → Import.")],
    fromSoftware: [L("In Odoo: select records → Action → Export → CSV.", "Odoo में: रिकॉर्ड चुनें → Action → Export → CSV।", "Odoo मध्ये: रेकॉर्ड निवडा → Action → Export → CSV."), BRING_IN],
    note: L("Live sync: Settings → Integrations → Odoo (needs an Odoo plan with API access).", "लाइव सिंक: Settings → Integrations → Odoo (API वाला Odoo प्लान चाहिए)।", "थेट सिंक: Settings → Integrations → Odoo (API असलेला Odoo प्लान हवा)."),
  },
  generic: {
    key: "generic",
    name: "Any other software",
    sends: L("GoKesari's standard Excel (Parties, Items, Voucher lines) and gokesari-books.json.", "GoKesari की मानक Excel (Parties, Items, Voucher lines) और gokesari-books.json।", "GoKesari ची मानक Excel (Parties, Items, Voucher lines) आणि gokesari-books.json."),
    toSoftware: [OPEN_SYNC, L("Use your software's Excel / CSV import and match its columns to the sheet headings once.", "अपने सॉफ़्टवेयर का Excel / CSV import चलाएँ और एक बार कॉलम मिलाएँ।", "तुमच्या सॉफ्टवेअरचा Excel / CSV import वापरा आणि एकदा कॉलम जुळवा.")],
    fromSoftware: [L("Fill the template pack's GoKesari standard sheets (or export them from your software with the same headings).", "टेम्पलेट पैक की GoKesari मानक शीट भरें (या उन्हीं शीर्षकों से अपने सॉफ़्टवेयर से निकालें)।", "टेम्पलेट पॅकमधील GoKesari मानक शीट भरा (किंवा त्याच शीर्षकांनी तुमच्या सॉफ्टवेअरमधून काढा)."), BRING_IN],
    note: L("Developers: GoKesari's REST API (OAuth2, per-shop access) is described at /api/public/v1/openapi.json.", "डेवलपर: GoKesari का REST API (OAuth2, हर दुकान की अनुमति) /api/public/v1/openapi.json पर है।", "डेव्हलपर: GoKesari चा REST API (OAuth2, प्रत्येक दुकानाची परवानगी) /api/public/v1/openapi.json वर आहे."),
  },
};
