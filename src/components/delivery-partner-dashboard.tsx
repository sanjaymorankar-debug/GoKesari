"use client";

import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useState } from "react";

import { Alert, Button, Card, Money } from "@/components/ui";
import { formatScheduledSlot } from "@/lib/scheduled-slots";
import { shrinkImage } from "@/components/image-uploader";
import { PickupQrScanner } from "@/components/pickup-qr-scanner";
import { SignaturePad, hasInk, signatureToPngBlob, type SignatureStroke } from "@/components/signature-pad";
import { FAILURE_REASON_CODES, FAILURE_REASON_LABELS, type FailureReasonCode } from "@/lib/delivery/failure-reasons";
import { errorText } from "@/lib/board/error-text";
import { L, tr, type Lang, type Text } from "@/lib/board/i18n";
import { requestAvailability, type RiderAvailability } from "@/components/rider-shell/availability";
import { YouEarn } from "@/components/rider-shell/pay-breakdown";
import { RejectReasonPicker } from "@/components/rider-shell/reject-reason-picker";
import type { RiderPayBreakdown } from "@/server/services/rider-job-board";

export interface ActiveDelivery {
  id: string;
  status: string;
  orderNumber: string;
  orderTotalPaise: number;
  /** Cash on delivery: the amount to collect at the door (null when prepaid). */
  cashToCollectPaise: number | null;
  /** GS-027: deliver within this slot (the customer's chosen time). */
  scheduledSlot?: { start: string; end: string } | null;
  /** NEW-007: a photo at the door is needed before "Mark delivered". */
  proofRequired?: boolean;
  proofUploaded?: boolean;
  /** Gig worker flow (feature 9): the optional photo at pickup has been added. */
  pickupPhotoUploaded?: boolean;
  /** Module 4 (rule deliveryProof): the customer-signature step is shown / needed, and whether one is in. */
  signatureEnabled?: boolean;
  signatureRequired?: boolean;
  signatureUploaded?: boolean;
  /** Module 4: send the phone's position with "delivered" / "failed" (nothing when location is refused). */
  captureGps?: boolean;
  /** Module 4: pick the failed-delivery reason from the fixed list. */
  failureReasonList?: boolean;
  shopName: string;
  shopAddress: string;
  customerAddress: string | null;
  distanceKm: string | null;
  /** F4: estimated minutes to ride to the shop / shop → customer; ROAD when from a routing service. */
  pickupDurationSeconds?: number | null;
  legDurationSeconds?: number | null;
  routeSource?: "ROAD" | "STRAIGHT_LINE" | null;
  /** The shop must give the rider a pickup code (Slice 4). */
  needsPickupCode: boolean;
  /** The customer must give the rider a delivery code. */
  needsDeliveryOtp: boolean;
  /** Too many wrong codes: the drop is locked until operations confirm it. */
  deliveryCodeLocked?: boolean;
  /** Set once the rider has left the shop for the customer. */
  outForDeliveryAt: Date | string | null;
  /** Landmark / customer's delivery instructions. */
  customerNotes: string | null;
  /** Society gate / parking notes, for society deliveries. */
  societyName: string | null;
  societyInstructions: string | null;
  acceptedAt?: Date | string | null;
  arrivedAtShopAt?: Date | string | null;
  pickedUpAt?: Date | string | null;
  arrivedAtCustomerAt?: Date | string | null;
  /** Where to collect and drop, with a maps deep link; the drop is coarse until pickup. */
  pickup?: { label: string; navigationUrl: string | null; notes: string | null };
  drop?: { label: string; navigationUrl: string | null; notes: string | null; precise: boolean };
  /** Society gate arrangement, for society deliveries. */
  gate?: { entryMode: string; contactName: string | null; contactPhone: string | null; deliveryHours?: { start: string; end: string } } | null;
}

/**
 * Module 4: the phone's current position for "delivered" / "failed", or null —
 * never throws and never blocks the action for long (location refused, no
 * fix within a few seconds: the action goes ahead without it).
 */
export function currentPositionOrNull(
  timeoutMs = 6_000,
): Promise<{ latitude: number; longitude: number; accuracyM: number } | null> {
  if (typeof navigator === "undefined" || !("geolocation" in navigator)) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: { latitude: number; longitude: number; accuracyM: number } | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs + 500);
    try {
      navigator.geolocation.getCurrentPosition(
        (position) =>
          finish({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracyM: Math.round(position.coords.accuracy),
          }),
        () => finish(null),
        { timeout: timeoutMs, maximumAge: 30_000, enableHighAccuracy: true },
      );
    } catch {
      finish(null);
    }
  });
}

const GATE_MODE_LABEL: Record<string, Text> = {
  OPEN: L("Open entry", "खुला प्रवेश", "मुक्त प्रवेश"),
  CALL_RESIDENT: L(
    "Security calls the resident before letting you in",
    "अंदर जाने से पहले सिक्योरिटी निवासी को फ़ोन करेगी",
    "आत सोडण्यापूर्वी सिक्युरिटी रहिवाशाला फोन करेल",
  ),
  PRE_APPROVAL: L(
    "Resident pre-approves the rider at the gate",
    "निवासी गेट पर राइडर को पहले से मंज़ूरी देते हैं",
    "रहिवासी गेटवर रायडरला आधीच मंजुरी देतात",
  ),
  DROP_AT_GATE: L("Hand the order over at the gate", "ऑर्डर गेट पर सौंपें", "ऑर्डर गेटवर द्या"),
};

/** Rider dashboard wording (Module 6, docs/hindi-marathi-2026-11/). */
const T = {
  stepAccepted: L("Accepted", "स्वीकारा", "स्वीकारली"),
  stepAtShop: L("At the shop", "दुकान पर", "दुकानात"),
  stepPickedUp: L("Picked up", "उठा लिया", "उचलली"),
  stepOnTheWay: L("On the way", "रास्ते में", "वाटेत"),
  stepAtCustomer: L("At the customer", "ग्राहक के पास", "ग्राहकाकडे"),
  deliveryProgress: L("Delivery progress", "डिलीवरी की प्रगति", "डिलिव्हरीची प्रगती"),
  offered: L("New delivery offer — accept within 2 minutes", "नया डिलीवरी ऑफ़र — 2 मिनट में स्वीकारें", "नवीन डिलिव्हरी ऑफर — 2 मिनिटांत स्वीकारा"),
  accepted: L(
    "Accepted — head to the shop and ask for the pickup code",
    "स्वीकार किया — दुकान पर जाएँ और पिकअप कोड माँगें",
    "स्वीकारली — दुकानात जा आणि पिकअप कोड मागा",
  ),
  pickedUp: L("Picked up — deliver to the customer", "उठा लिया — ग्राहक को डिलीवर करें", "उचलली — ग्राहकाला डिलिव्हरी करा"),
  offlineTitle: L("You're offline", "आप ऑफ़लाइन हैं", "तुम्ही ऑफलाइन आहात"),
  offlineBody: L(
    "Switch to Ready to start receiving deliveries.",
    "डिलीवरी पाने के लिए तैयार (Ready) चुनें।",
    "डिलिव्हरी मिळवण्यासाठी तयार (Ready) निवडा.",
  ),
  activeTitle: L("You're active", "आप सक्रिय हैं", "तुम्ही सक्रिय आहात"),
  activeBody: L(
    "On duty and sharing your location, but not taking new orders.",
    "ड्यूटी पर हैं और लोकेशन शेयर हो रही है, पर नए ऑर्डर नहीं ले रहे।",
    "ड्युटीवर आहात आणि लोकेशन शेअर होत आहे, पण नवीन ऑर्डर घेत नाही.",
  ),
  readyTitle: L("You're ready", "आप तैयार हैं", "तुम्ही तयार आहात"),
  readyBody: L(
    "You may be offered deliveries near you (pickup and drop within your zone).",
    "आपको आस-पास की डिलीवरी मिल सकती है (पिकअप और ड्रॉप आपके ज़ोन में)।",
    "तुम्हाला जवळच्या डिलिव्हरी मिळू शकतात (पिकअप आणि ड्रॉप तुमच्या झोनमध्ये).",
  ),
  availability: L("Availability", "उपलब्धता", "उपलब्धता"),
  optOffline: L("Offline", "ऑफ़लाइन", "ऑफलाइन"),
  optActive: L("Active", "सक्रिय", "सक्रिय"),
  optReady: L("Ready", "तैयार", "तयार"),
  gateTitle: L("Finish verification to go Active or Ready", "सक्रिय या तैयार होने के लिए सत्यापन पूरा करें", "सक्रिय किंवा तयार होण्यासाठी पडताळणी पूर्ण करा"),
  stillNeeded: L("Still needed: {list}.", "अभी बाकी: {list}।", "अजून बाकी: {list}."),
  policeDocs: L("Police verification documents", "पुलिस सत्यापन दस्तावेज़", "पोलीस पडताळणी कागदपत्रे"),
  locBlockedTitle: L("Location is blocked", "लोकेशन बंद है", "लोकेशन बंद आहे"),
  locBlockedBody: L(
    "Nearby offers and live tracking for customers won't work. Allow location for this site in your browser settings, then reload this page.",
    "आस-पास के ऑफ़र और ग्राहकों के लिए लाइव ट्रैकिंग काम नहीं करेंगे। ब्राउज़र सेटिंग में इस साइट को लोकेशन की अनुमति दें, फिर पेज रीलोड करें।",
    "जवळच्या ऑफर आणि ग्राहकांसाठी थेट ट्रॅकिंग चालणार नाही. ब्राउझर सेटिंगमध्ये या साइटला लोकेशनची परवानगी द्या, मग पान रीलोड करा.",
  ),
  reload: L("Reload", "रीलोड करें", "रीलोड करा"),
  locUnauthTitle: L("Your location isn't being shared", "आपकी लोकेशन शेयर नहीं हो रही", "तुमचे लोकेशन शेअर होत नाही"),
  locUnauthBody: L(
    "Switch to your Delivery Partner role from the “Acting as” menu at the top of the page, or sign in again.",
    "पेज के ऊपर “भूमिका” मेनू से डिलीवरी पार्टनर भूमिका चुनें, या फिर से साइन इन करें।",
    "पानाच्या वरच्या “भूमिका” मेनूमधून डिलिव्हरी पार्टनर भूमिका निवडा, किंवा पुन्हा साइन इन करा.",
  ),
  locUnavailTitle: L("We can't read your location", "हम आपकी लोकेशन नहीं पढ़ पा रहे", "आम्हाला तुमचे लोकेशन वाचता येत नाही"),
  locUnavailBody: L(
    "Nearby offers and live tracking for customers won't work until we can. Turn on location services for your device, or move somewhere with a clearer signal.",
    "जब तक लोकेशन नहीं मिलती, आस-पास के ऑफ़र और लाइव ट्रैकिंग काम नहीं करेंगे। फ़ोन की लोकेशन चालू करें, या बेहतर सिग्नल वाली जगह जाएँ।",
    "लोकेशन मिळेपर्यंत जवळच्या ऑफर आणि थेट ट्रॅकिंग चालणार नाही. फोनचे लोकेशन सुरू करा, किंवा चांगला सिग्नल असलेल्या ठिकाणी जा.",
  ),
  today: L("Today", "आज", "आज"),
  totalEarned: L("Total earned", "कुल कमाई", "एकूण कमाई"),
  deliveries: L("Deliveries", "डिलीवरी", "डिलिव्हऱ्या"),
  ratingFrom: L("from {n}", "{n} रेटिंग से", "{n} रेटिंगवरून"),
  deliverSlot: L("Deliver {slot}", "डिलीवरी {slot}", "डिलिव्हरी {slot}"),
  pickup: L("Pickup", "पिकअप", "पिकअप"),
  note: L("Note:", "नोट:", "टीप:"),
  navShop: L("Navigate to the shop", "दुकान तक रास्ता", "दुकानापर्यंत मार्ग"),
  drop: L("Drop", "ड्रॉप", "ड्रॉप"),
  addressOnOrder: L("Address on order details", "पता ऑर्डर विवरण में", "पत्ता ऑर्डर तपशिलात"),
  fullAddressLater: L(
    "The full address and navigation appear once you pick up the order.",
    "ऑर्डर उठाने के बाद पूरा पता और रास्ता दिखेगा।",
    "ऑर्डर उचलल्यानंतर पूर्ण पत्ता आणि मार्ग दिसेल.",
  ),
  navCustomer: L("Navigate to the customer", "ग्राहक तक रास्ता", "ग्राहकापर्यंत मार्ग"),
  gate: L("Gate:", "गेट:", "गेट:"),
  securityDesk: L("Security desk", "सिक्योरिटी डेस्क", "सिक्युरिटी डेस्क"),
  turnByTurn: L("Turn-by-turn navigation", "कदम-दर-कदम रास्ता", "टप्प्याटप्प्याने मार्ग"),
  codCollect: L("Cash on delivery — collect", "कैश ऑन डिलीवरी — लें", "कॅश ऑन डिलिव्हरी — घ्या"),
  kmLeg: L("~{km} km delivery leg", "~{km} km डिलीवरी दूरी", "~{km} km डिलिव्हरी अंतर"),
  byRoad: L(" by road", " सड़क से", " रस्त्याने"),
  etaShopThen: L(
    "About {n} min to the shop, then ",
    "दुकान तक लगभग {n} min, फिर ",
    "दुकानापर्यंत सुमारे {n} min, मग ",
  ),
  etaAbout: L("About ", "लगभग ", "सुमारे "),
  etaCustomer: L("{n} min to the customer", "ग्राहक तक {n} min", "ग्राहकापर्यंत {n} min"),
  accept: L("Accept", "स्वीकारें", "स्वीकारा"),
  reject: L("Reject", "मना करें", "नाकारा"),
  arrivedShop: L("I've arrived at the shop", "मैं दुकान पर पहुँच गया", "मी दुकानात पोहोचलो"),
  pickupCodeLabel: L("Pickup code from the shop", "दुकान से पिकअप कोड", "दुकानाकडून पिकअप कोड"),
  confirmPickup: L("Confirm pickup", "पिकअप पक्का करें", "पिकअप निश्चित करा"),
  startDelivery: L("Start delivery", "डिलीवरी शुरू करें", "डिलिव्हरी सुरू करा"),
  arrivedCustomer: L("I've arrived at the customer", "मैं ग्राहक के पास पहुँच गया", "मी ग्राहकाकडे पोहोचलो"),
  lockedTitle: L("Delivery locked", "डिलीवरी लॉक हो गई", "डिलिव्हरी लॉक झाली"),
  lockedBody: L(
    "Too many wrong delivery codes. A support ticket has been raised — operations will confirm this delivery with the customer. Wait here or follow their instructions.",
    "बहुत बार गलत डिलीवरी कोड डाला गया। सपोर्ट टिकट बन गया है — ऑपरेशंस टीम ग्राहक से यह डिलीवरी पक्की करेगी। यहीं रुकें या उनके निर्देश मानें।",
    "खूप वेळा चुकीचा डिलिव्हरी कोड टाकला. सपोर्ट तिकीट तयार झाले आहे — ऑपरेशन्स टीम ग्राहकाकडून ही डिलिव्हरी निश्चित करेल. इथेच थांबा किंवा त्यांच्या सूचना पाळा.",
  ),
  deliveryCodeLabel: L("Delivery code from the customer", "ग्राहक से डिलीवरी कोड", "ग्राहकाकडून डिलिव्हरी कोड"),
  collectedPre: L("I collected", "मैंने", "मी"),
  collectedPost: L("in cash", "नकद लिए", "रोख घेतले"),
  markDelivered: L("Mark delivered", "डिलीवर हुआ दर्ज करें", "डिलिव्हरी झाली नोंदवा"),
  couldNotDeliver: L("Could not deliver", "डिलीवरी नहीं हो सकी", "डिलिव्हरी होऊ शकली नाही"),
  failPlaceholder: L("What happened? e.g. customer not reachable", "क्या हुआ? जैसे ग्राहक से संपर्क नहीं हुआ", "काय झाले? उदा. ग्राहकाशी संपर्क झाला नाही"),
  failAria: L("Reason the delivery failed", "डिलीवरी न होने का कारण", "डिलिव्हरी न होण्याचे कारण"),
  reportFailed: L("Report failed delivery", "असफल डिलीवरी दर्ज करें", "अयशस्वी डिलिव्हरी नोंदवा"),
  waiting: L("Waiting for a delivery offer…", "डिलीवरी ऑफ़र का इंतज़ार…", "डिलिव्हरी ऑफरची वाट पाहत आहे…"),
  errNoServer: L(
    "Could not reach the server. Check your connection and try again.",
    "सर्वर से संपर्क नहीं हो सका। इंटरनेट देखें और फिर कोशिश करें।",
    "सर्व्हरशी संपर्क झाला नाही. इंटरनेट तपासा आणि पुन्हा प्रयत्न करा.",
  ),
  errOffline: L("Could not go offline. Try again.", "ऑफ़लाइन नहीं हो सके। फिर कोशिश करें।", "ऑफलाइन होता आले नाही. पुन्हा प्रयत्न करा."),
  errNoGeo: L(
    "Your browser does not support location — cannot go online.",
    "आपका ब्राउज़र लोकेशन सपोर्ट नहीं करता — ऑनलाइन नहीं हो सकते।",
    "तुमचा ब्राउझर लोकेशनला सपोर्ट करत नाही — ऑनलाइन होता येणार नाही.",
  ),
  errNoFix: L("Could not get your location. Try again.", "आपकी लोकेशन नहीं मिली। फिर कोशिश करें।", "तुमचे लोकेशन मिळाले नाही. पुन्हा प्रयत्न करा."),
  errActive: L("Could not switch to Active.", "सक्रिय नहीं हो सके।", "सक्रिय होता आले नाही."),
  errReady: L("Could not switch to Ready.", "तैयार पर नहीं जा सके।", "तयार वर जाता आले नाही."),
  errPermission: L(
    "Location permission is required to go online.",
    "ऑनलाइन होने के लिए लोकेशन की अनुमति ज़रूरी है।",
    "ऑनलाइन होण्यासाठी लोकेशनची परवानगी आवश्यक आहे.",
  ),
  errAction: L("Action failed.", "काम नहीं हो सका।", "कृती अयशस्वी झाली."),
  rpOffered: L(
    "New return pickup — accept within the offer time",
    "नया रिटर्न पिकअप — ऑफ़र के समय में स्वीकारें",
    "नवीन रिटर्न पिकअप — ऑफरच्या वेळेत स्वीकारा",
  ),
  rpAccepted: L(
    "Return pickup accepted — head to the customer when ready",
    "रिटर्न पिकअप स्वीकारा — तैयार होने पर ग्राहक के पास जाएँ",
    "रिटर्न पिकअप स्वीकारले — तयार झाल्यावर ग्राहकाकडे जा",
  ),
  rpEnRoute: L("On the way to the customer", "ग्राहक के पास जा रहे हैं", "ग्राहकाकडे जात आहात"),
  returnNo: L("Return {n}", "रिटर्न {n}", "रिटर्न {n}"),
  collectFrom: L("Collect from", "यहाँ से लें", "इथून घ्या"),
  fullAddressSetOff: L(
    "The full address and navigation appear once you set off.",
    "निकलने के बाद पूरा पता और रास्ता दिखेगा।",
    "निघाल्यानंतर पूर्ण पत्ता आणि मार्ग दिसेल.",
  ),
  readyFrom: L("Ready from {when}", "{when} से तैयार", "{when} पासून तयार"),
  bringBack: L("Bring back to", "यहाँ वापस लाएँ", "इथे परत आणा"),
  setOff: L("Set off to the customer", "ग्राहक के पास निकलें", "ग्राहकाकडे निघा"),
  handoverLabel: L("Handover code from the customer", "ग्राहक से सौंपने का कोड", "ग्राहकाकडून हस्तांतरण कोड"),
  couldNotCollect: L("Could not collect", "सामान नहीं ले सके", "माल घेता आला नाही"),
  rpFailPlaceholder: L("What happened? e.g. customer not home", "क्या हुआ? जैसे ग्राहक घर पर नहीं", "काय झाले? उदा. ग्राहक घरी नाही"),
  rpFailAria: L("Reason the pickup failed", "पिकअप न होने का कारण", "पिकअप न होण्याचे कारण"),
  reportFailedPickup: L("Report failed pickup", "असफल पिकअप दर्ज करें", "अयशस्वी पिकअप नोंदवा"),
  errPhoto: L("Could not upload the photo.", "फ़ोटो अपलोड नहीं हो सकी।", "फोटो अपलोड करता आला नाही."),
  errPhotoNet: L(
    "Could not upload the photo. Check your connection and try again.",
    "फ़ोटो अपलोड नहीं हो सकी। इंटरनेट देखें और फिर कोशिश करें।",
    "फोटो अपलोड करता आला नाही. इंटरनेट तपासा आणि पुन्हा प्रयत्न करा.",
  ),
  pickupPhotoDone: L("Pickup photo added ✓ — retake if needed", "पिकअप फ़ोटो जुड़ गई ✓ — ज़रूरत हो तो फिर लें", "पिकअप फोटो जोडला ✓ — गरज असल्यास पुन्हा काढा"),
  pickupPhoto: L("Photo of the parcel at pickup (optional)", "पिकअप पर पार्सल की फ़ोटो (वैकल्पिक)", "पिकअपवेळी पार्सलचा फोटो (ऐच्छिक)"),
  doorPhotoDone: L("Photo at the door added ✓ — retake if needed", "दरवाज़े की फ़ोटो जुड़ गई ✓ — ज़रूरत हो तो फिर लें", "दारावरचा फोटो जोडला ✓ — गरज असल्यास पुन्हा काढा"),
  doorPhoto: L("Photo of the order at the door (required)", "दरवाज़े पर ऑर्डर की फ़ोटो (ज़रूरी)", "दारावर ऑर्डरचा फोटो (आवश्यक)"),
  uploading: L("Uploading…", "अपलोड हो रहा है…", "अपलोड होत आहे…"),
} as const;

/** The five checkpoints a rider moves through, with what has been reached. */
function ProgressSteps({ delivery, lang = "en" }: { delivery: ActiveDelivery; lang?: Lang }) {
  const steps: { label: string; done: boolean }[] = [
    { label: tr(T.stepAccepted, lang), done: Boolean(delivery.acceptedAt) || delivery.status !== "OFFERED" },
    { label: tr(T.stepAtShop, lang), done: Boolean(delivery.arrivedAtShopAt) || delivery.status === "PICKED_UP" },
    { label: tr(T.stepPickedUp, lang), done: delivery.status === "PICKED_UP" },
    { label: tr(T.stepOnTheWay, lang), done: Boolean(delivery.outForDeliveryAt) },
    { label: tr(T.stepAtCustomer, lang), done: Boolean(delivery.arrivedAtCustomerAt) },
  ];
  return (
    <ol className="mt-3 flex flex-wrap gap-1 text-xs" aria-label={tr(T.deliveryProgress, lang)} data-testid="delivery-progress">
      {steps.map((step) => (
        <li
          key={step.label}
          className={`rounded-full px-2 py-0.5 ${step.done ? "bg-leaf-100 text-leaf-800" : "bg-cream-100 text-ink-500"}`}
        >
          {step.done ? "✓ " : ""}
          {step.label}
        </li>
      ))}
    </ol>
  );
}

export interface ActiveReturnPickupView {
  id: string;
  status: string;
  returnNumber: string;
  scheduledFor: Date | string | null;
  needsHandoverCode: boolean;
  shopName: string;
  shopAddress: string;
  itemSummary: string;
  customerAddress: string | null;
  customerNotes: string | null;
  navigationUrl: string | null;
  shopNavigationUrl: string | null;
}

export interface EarningsSummary {
  todayPaise: number;
  totalPaise: number;
  deliveryCount: number;
}

export interface RiderRating {
  avgX100: number;
  count: number;
}

const STATUS_LABEL: Record<string, Text> = {
  OFFERED: T.offered,
  ACCEPTED: T.accepted,
  PICKED_UP: T.pickedUp,
};

// Customers poll tracking every 15s; idle riders only need to be fresh enough for dispatch.
// Exported (batch-2026-10 WS-B) so the rider's navigation screen keeps the same cadence.
export const HEARTBEAT_ON_DELIVERY_MS = 15_000;
export const HEARTBEAT_IDLE_MS = 60_000;
/** Live tracking: once the drop starts; the server's `nextPingSeconds` (rule tracking.riderPingSeconds) replaces it. */
export const TRACKING_PING_DEFAULT_MS = 5_000;
// Checked every second so a 5-second cadence is kept, not rounded up to the next tick.
const HEARTBEAT_TICK_MS = 1_000;
export const RIDER_LOCATION_URL = "/api/delivery-partner/location";

export interface LocationReply {
  shared?: boolean;
  /** Live tracking endpoint only: false once the drop is over — nothing more is stored. */
  sharing?: boolean;
  nextPingSeconds?: number;
}
const MAX_FIX_AGE_MS = 2 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const LOCATION_TIMEOUT_MS = 20_000;

type LocationIssue = "blocked" | "unauthorized" | "unavailable" | null;

interface Fix {
  latitude: number;
  longitude: number;
  receivedAt: number;
  receivedWallAt: number;
}

function isStale(fix: Fix): boolean {
  // performance.now() pauses while some phones sleep, so the wall-clock receipt time is a second bound.
  return performance.now() - fix.receivedAt > MAX_FIX_AGE_MS || Date.now() - fix.receivedWallAt > MAX_FIX_AGE_MS;
}

/**
 * Posts the rider's position while online: to /api/delivery-partner/location
 * (for matching), or — once a drop has started — to that delivery's live
 * tracking endpoint. The server ignores it if the rider is offline, so this
 * never writes location outside an online session.
 */
export function useLocationHeartbeat(
  enabled: boolean,
  intervalMs: number,
  onServerOffline: () => void,
  endpoint: string = RIDER_LOCATION_URL,
  onReply?: (reply: LocationReply) => void,
): LocationIssue {
  const [blocked, setBlocked] = useState(false);
  const [unauthorized, setUnauthorized] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [arm, setArm] = useState(0);
  const serverOffline = useEffectEvent(onServerOffline);
  const replied = useEffectEvent((reply: LocationReply) => onReply?.(reply));

  // Alerts from a previous online stretch must not resurface when the rider goes online again.
  const [wasEnabled, setWasEnabled] = useState(enabled);
  if (wasEnabled !== enabled) {
    setWasEnabled(enabled);
    if (!enabled) {
      setBlocked(false);
      setUnauthorized(false);
      setUnavailable(false);
    }
  }

  useEffect(() => {
    if (!enabled || !("geolocation" in navigator)) return;
    const geo = navigator.geolocation;
    let latest: Fix | null = null;
    let lastSentAt = -Infinity;
    let inFlight: AbortController | null = null;
    let refreshing = false;
    let denied = false;
    let disposed = false;
    let permission: PermissionStatus | null = null;
    // When errors started with no fix in between; performance.now() pauses in sleep, so a wake-up never counts as a gap.
    let failingSince: number | null = null;

    function remember(position: GeolocationPosition) {
      latest = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        receivedAt: performance.now(),
        receivedWallAt: Date.now(),
      };
      failingSince = null;
      setBlocked(false);
      setUnavailable(false);
    }

    function fail(err: GeolocationPositionError) {
      if (err.code === err.PERMISSION_DENIED) {
        denied = true;
        setBlocked(true);
        return;
      }
      // POSITION_UNAVAILABLE / TIMEOUT: device location off, or no fix indoors. Tell the rider once it has lasted.
      const now = performance.now();
      if (failingSince === null) failingSince = now;
      if (now - failingSince >= MAX_FIX_AGE_MS) setUnavailable(true);
    }

    // Some providers only report on movement, so a stationary rider needs an explicit fresh fix.
    function refresh() {
      if (refreshing || denied) return;
      refreshing = true;
      try {
        geo.getCurrentPosition(
          (position) => {
            refreshing = false;
            if (disposed) return;
            remember(position);
            sendIfDue();
          },
          (err) => {
            refreshing = false;
            if (!disposed) fail(err);
          },
          { enableHighAccuracy: true, maximumAge: 0, timeout: LOCATION_TIMEOUT_MS },
        );
      } catch {
        // A synchronous throw (embedded WebView, Permissions-Policy) will not clear on retry; surface it as blocked.
        refreshing = false;
        denied = true;
        if (!disposed) setBlocked(true);
      }
    }

    function sendIfDue() {
      if (disposed || inFlight || performance.now() - lastSentAt < intervalMs) return;
      if (!latest || isStale(latest)) {
        refresh();
        return;
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      inFlight = controller;
      lastSentAt = performance.now();
      fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ latitude: latest.latitude, longitude: latest.longitude }),
        signal: controller.signal,
      })
        .then(async (response) => {
          if (disposed) return;
          if (response.status === 401 || response.status === 403) {
            setUnauthorized(true);
            return;
          }
          if (!response.ok) return;
          setUnauthorized(false);
          const body: unknown = await response.json();
          if (disposed || typeof body !== "object" || body === null) return;
          const reply = body as LocationReply;
          if (reply.shared === false) serverOffline();
          else replied(reply);
        })
        .catch(() => {})
        .finally(() => {
          clearTimeout(timeout);
          if (inFlight === controller) inFlight = null;
        });
    }

    // A denial kills the watch; re-arm once the rider allows location again (Safari never fires this — hence Reload).
    function onPermissionChange() {
      if (!denied || permission?.state === "denied") return;
      setBlocked(false);
      setArm((n) => n + 1);
    }
    if ("permissions" in navigator) {
      navigator.permissions.query({ name: "geolocation" }).then(
        (status) => {
          if (disposed) return;
          permission = status;
          status.addEventListener("change", onPermissionChange);
        },
        () => {},
      );
    }

    let watchId: number | null = null;
    try {
      watchId = geo.watchPosition(
        (position) => {
          remember(position);
          sendIfDue();
        },
        fail,
        { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 },
      );
    } catch {
      // Left unarmed: the first tick's refresh() hits the same failure and raises the blocked alert.
    }
    const timer = setInterval(sendIfDue, HEARTBEAT_TICK_MS);

    return () => {
      disposed = true;
      if (watchId !== null) geo.clearWatch(watchId);
      clearInterval(timer);
      inFlight?.abort();
      permission?.removeEventListener("change", onPermissionChange);
    };
  }, [enabled, intervalMs, arm, endpoint]);

  if (!enabled) return null;
  if (blocked) return "blocked";
  if (unauthorized) return "unauthorized";
  return unavailable ? "unavailable" : null;
}

/** 4-digit code entry for pickup/delivery handover. */
function CodeInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <input
      className="w-40 rounded-lg border border-cream-200 px-3 py-2 text-sm tracking-widest"
      inputMode="numeric"
      maxLength={4}
      placeholder={label}
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, ""))}
    />
  );
}

/**
 * Online/offline toggle, active delivery actions, earnings summary
 * (delivery-system Part 58, Slice C). Location comes only from the
 * browser's native geolocation — never a Google Maps Platform call.
 */
export type { RiderAvailability };

const AVAILABILITY_TEXT: Record<RiderAvailability, { title: Text; body: Text }> = {
  OFFLINE: { title: T.offlineTitle, body: T.offlineBody },
  ACTIVE: { title: T.activeTitle, body: T.activeBody },
  READY: { title: T.readyTitle, body: T.readyBody },
};

export function DeliveryPartnerDashboard({
  isOnline: initialOnline,
  availability: initialAvailability,
  gate = null,
  activeDelivery,
  activeReturnPickup = null,
  earnings,
  rating,
  offerLabel,
  pickupQr = false,
  inAppNavigation = false,
  offerEarn = null,
  lang = "en",
}: {
  isOnline: boolean;
  /** Gig worker flow (feature 5): Offline / Active / Ready; only Ready gets new offers. */
  availability?: RiderAvailability;
  /** Gig worker flow: what still blocks Active / Ready (KYC, police verification), unless overridden. */
  gate?: { allowed: boolean; missing: string[] } | null;
  activeDelivery: ActiveDelivery | null;
  /** A customer return the rider is collecting (goods go back to the shop). */
  activeReturnPickup?: ActiveReturnPickupView | null;
  earnings: EarningsSummary;
  /** The rider's own average (GS-060), shown only to them. */
  rating?: RiderRating;
  /** batch-2026-10 WS-B: the new-offer line with the time from the rules (only while broadcasting is on). */
  offerLabel?: string;
  /** batch-2026-10 WS-B: rule pickupQr on — scan the shop's QR to confirm pickup. */
  pickupQr?: boolean;
  /** batch-2026-10 WS-B: rule riderNavigation on — link to the in-app navigation screen. */
  inAppNavigation?: boolean;
  /** Rider App v2 (G1): what the rider earns on the OFFERED delivery, worked out on the server (quoteForOwnOffer). */
  offerEarn?: { earnPaise: number | null; breakdown: RiderPayBreakdown | null; locked: boolean } | null;
  /** Module 6: board language (Hindi / Marathi); English by default. */
  lang?: Lang;
}) {
  const router = useRouter();
  const [rejecting, setRejecting] = useState(false);
  const startingAvailability: RiderAvailability = initialAvailability ?? (initialOnline ? "READY" : "OFFLINE");
  const [availability, setAvailability] = useState<RiderAvailability>(startingAvailability);
  const [serverAvailability, setServerAvailability] = useState<RiderAvailability>(startingAvailability);
  if (serverAvailability !== startingAvailability) {
    setServerAvailability(startingAvailability);
    setAvailability(startingAvailability);
  }
  const isOnline = availability !== "OFFLINE";
  const setIsOnline = (online: boolean) => setAvailability(online ? "READY" : "OFFLINE");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [failReason, setFailReason] = useState("");
  const [failCode, setFailCode] = useState<FailureReasonCode | "">("");
  const [showFail, setShowFail] = useState(false);
  const [cashCollected, setCashCollected] = useState(false);
  const onDelivery = activeDelivery?.status === "PICKED_UP";
  // Live tracking: from the start of the drop the customer can follow the rider.
  const dropStarted = onDelivery && Boolean(activeDelivery?.outForDeliveryAt);
  const [trackingPingMs, setTrackingPingMs] = useState(TRACKING_PING_DEFAULT_MS);
  const locationIssue = useLocationHeartbeat(
    isOnline,
    dropStarted ? trackingPingMs : onDelivery ? HEARTBEAT_ON_DELIVERY_MS : HEARTBEAT_IDLE_MS,
    () => {
      setIsOnline(false);
      router.refresh();
    },
    dropStarted && activeDelivery ? `/api/delivery-orders/${activeDelivery.id}/location` : RIDER_LOCATION_URL,
    (reply) => {
      if (typeof reply.nextPingSeconds === "number" && reply.nextPingSeconds * 1000 !== trackingPingMs) {
        setTrackingPingMs(reply.nextPingSeconds * 1000);
      }
      // The drop is over (delivered or cancelled elsewhere): stop sharing and reload the job.
      if (reply.sharing === false) router.refresh();
    },
  );

  // Shared with the Rider App v2 header's Online/Offline toggle (rider-shell/availability.ts).
  async function changeAvailability(target: RiderAvailability) {
    setError(null);
    if (target === availability) return;
    setBusy(true);
    try {
      const result = await requestAvailability(target, lang);
      if (result.ok) {
        setAvailability(target);
        router.refresh();
        return;
      }
      if (result.error) setError(result.error);
      // The change may have committed before the response was lost; re-read the real online flag.
      if (result.refresh) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function act(
    action: "accept" | "reject" | "arrived_shop" | "pickup" | "start" | "arrived_customer" | "deliver" | "fail",
    extra: Record<string, string | boolean> = {},
  ) {
    if (!activeDelivery) return;
    setBusy(true);
    setError(null);
    try {
      // Module 4 (rule deliveryProof.captureGps): where the drop was confirmed or failed, when the phone allows it.
      const position =
        activeDelivery.captureGps && (action === "deliver" || action === "fail") ? await currentPositionOrNull() : null;
      const response = await fetch(`/api/delivery-orders/${activeDelivery.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra, ...(position ?? {}) }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(errorText(payload?.error?.message ?? tr(T.errAction, lang), lang, payload?.error?.code));
        return;
      }
      setCode("");
      setFailReason("");
      setFailCode("");
      setShowFail(false);
      setCashCollected(false);
      router.refresh();
    } catch {
      setError(tr(T.errNoServer, lang));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-5" data-testid="availability-toggle">
        <div>
          <p className="font-semibold text-ink-900">{tr(AVAILABILITY_TEXT[availability].title, lang)}</p>
          <p className="text-sm text-ink-500">{tr(AVAILABILITY_TEXT[availability].body, lang)}</p>
        </div>
        <div role="radiogroup" aria-label={tr(T.availability, lang)} className="grid grid-cols-3 gap-2">
          {(["OFFLINE", "ACTIVE", "READY"] as const).map((option) => {
            const selected = availability === option;
            // Going offline needs the current delivery finished; Active / Ready need the verification gate.
            const blocked =
              (option === "OFFLINE" && Boolean(activeDelivery) && isOnline) || (option !== "OFFLINE" && gate !== null && !gate.allowed);
            return (
              <Button
                key={option}
                role="radio"
                aria-checked={selected}
                variant={selected ? "primary" : "secondary"}
                disabled={busy || blocked}
                onClick={() => changeAvailability(option)}
                data-testid={`availability-${option.toLowerCase()}`}
              >
                {tr(option === "OFFLINE" ? T.optOffline : option === "ACTIVE" ? T.optActive : T.optReady, lang)}
              </Button>
            );
          })}
        </div>
        {gate && !gate.allowed ? (
          <Alert tone="warning" title={tr(T.gateTitle, lang)}>
            <p>{tr(T.stillNeeded, lang).replace("{list}", gate.missing.join("; "))}</p>
            <p className="mt-1 flex flex-wrap items-center gap-x-4">
              <a className="inline-flex min-h-11 min-w-11 items-center font-semibold underline" href="/delivery-partner/kyc">
                KYC
              </a>
              <a className="inline-flex min-h-11 items-center font-semibold underline" href="/delivery-partner/documents">
                {tr(T.policeDocs, lang)}
              </a>
            </p>
          </Alert>
        ) : null}
      </Card>

      {locationIssue === "blocked" ? (
        <Alert tone="warning" title={tr(T.locBlockedTitle, lang)}>
          <p>{tr(T.locBlockedBody, lang)}</p>
          <div className="mt-2">
            <Button size="sm" variant="secondary" className="min-h-11" onClick={() => window.location.reload()}>
              {tr(T.reload, lang)}
            </Button>
          </div>
        </Alert>
      ) : null}
      {locationIssue === "unauthorized" ? (
        <Alert tone="warning" title={tr(T.locUnauthTitle, lang)}>
          {tr(T.locUnauthBody, lang)}
        </Alert>
      ) : null}
      {locationIssue === "unavailable" ? (
        <Alert tone="warning" title={tr(T.locUnavailTitle, lang)}>
          {tr(T.locUnavailBody, lang)}
        </Alert>
      ) : null}

      <div className="grid grid-cols-3 gap-3">
        <Card className="p-4">
          <p className="text-xs text-ink-500">{tr(T.today, lang)}</p>
          <p className="mt-1 text-lg font-bold text-ink-900">
            <Money paise={earnings.todayPaise} />
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-500">{tr(T.totalEarned, lang)}</p>
          <p className="mt-1 text-lg font-bold text-ink-900">
            <Money paise={earnings.totalPaise} />
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-500">{tr(T.deliveries, lang)}</p>
          <p className="mt-1 text-lg font-bold text-ink-900">{earnings.deliveryCount}</p>
          {rating && rating.count > 0 ? (
            <p className="text-xs text-ink-500">
              {(rating.avgX100 / 100).toFixed(1)}★ {tr(T.ratingFrom, lang).replace("{n}", String(rating.count))}
            </p>
          ) : null}
        </Card>
      </div>

      {activeDelivery ? (
        <Card className="p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-kesari-600">
            {(activeDelivery.status === "OFFERED" ? offerLabel : undefined) ??
              (STATUS_LABEL[activeDelivery.status] ? tr(STATUS_LABEL[activeDelivery.status], lang) : undefined) ??
              activeDelivery.status}
          </p>
          <p className="mt-2 font-semibold text-ink-900">{activeDelivery.orderNumber}</p>
          {activeDelivery.scheduledSlot ? (
            <p className="mt-1 text-sm font-medium text-kesari-700" data-testid="rider-scheduled-slot">
              {tr(T.deliverSlot, lang).replace("{slot}", formatScheduledSlot(activeDelivery.scheduledSlot.start, activeDelivery.scheduledSlot.end))}
            </p>
          ) : null}
          {activeDelivery.status !== "OFFERED" ? <ProgressSteps delivery={activeDelivery} lang={lang} /> : null}
          <div className="mt-3 space-y-2 text-sm">
            <div>
              <p className="font-medium text-ink-700">{tr(T.pickup, lang)}</p>
              <p className="text-ink-500">{activeDelivery.shopName} — {activeDelivery.shopAddress}</p>
              {activeDelivery.pickup?.notes ? <p className="text-ink-500">{tr(T.note, lang)} {activeDelivery.pickup.notes}</p> : null}
              {activeDelivery.pickup?.navigationUrl && activeDelivery.status !== "OFFERED" && activeDelivery.status !== "PICKED_UP" ? (
                <a
                  href={activeDelivery.pickup.navigationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-block text-sm font-medium text-kesari-700 underline"
                  data-testid="navigate-pickup"
                >
                  {tr(T.navShop, lang)}
                </a>
              ) : null}
            </div>
            <div>
              <p className="font-medium text-ink-700">{tr(T.drop, lang)}</p>
              <p className="text-ink-500">{activeDelivery.customerAddress ?? tr(T.addressOnOrder, lang)}</p>
              {activeDelivery.drop && !activeDelivery.drop.precise ? (
                <p className="text-xs text-ink-500">{tr(T.fullAddressLater, lang)}</p>
              ) : null}
              {activeDelivery.customerNotes ? <p className="text-ink-500">{tr(T.note, lang)} {activeDelivery.customerNotes}</p> : null}
              {activeDelivery.drop?.navigationUrl && activeDelivery.status === "PICKED_UP" ? (
                <a
                  href={activeDelivery.drop.navigationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-block text-sm font-medium text-kesari-700 underline"
                  data-testid="navigate-drop"
                >
                  {tr(T.navCustomer, lang)}
                </a>
              ) : null}
            </div>
            {activeDelivery.societyName ? (
              <div className="rounded-lg bg-cream-100 p-2" data-testid="society-notes">
                <p className="font-medium text-ink-700">{activeDelivery.societyName}</p>
                {activeDelivery.gate ? (
                  <p className="text-ink-600">
                    {tr(T.gate, lang)}{" "}
                    {GATE_MODE_LABEL[activeDelivery.gate.entryMode]
                      ? tr(GATE_MODE_LABEL[activeDelivery.gate.entryMode], lang)
                      : activeDelivery.gate.entryMode}
                  </p>
                ) : null}
                {activeDelivery.gate?.deliveryHours ? (
                  <p className="text-ink-600" data-testid="society-delivery-hours">
                    {activeDelivery.gate.deliveryHours.start}–{activeDelivery.gate.deliveryHours.end}
                  </p>
                ) : null}
                {activeDelivery.societyInstructions ? (
                  <p className="text-ink-600">{activeDelivery.societyInstructions}</p>
                ) : null}
                {activeDelivery.gate?.contactPhone ? (
                  <p className="text-ink-600">
                    {tr(T.securityDesk, lang)}{activeDelivery.gate.contactName ? ` (${activeDelivery.gate.contactName})` : ""}:{" "}
                    <a href={`tel:${activeDelivery.gate.contactPhone}`} className="underline">
                      {activeDelivery.gate.contactPhone}
                    </a>
                  </p>
                ) : null}
              </div>
            ) : null}
            {inAppNavigation && (activeDelivery.status === "ACCEPTED" || activeDelivery.status === "PICKED_UP") ? (
              <a
                href={`/delivery-partner/navigate/${activeDelivery.id}`}
                className="inline-block rounded-lg border border-kesari-300 px-3 py-2 text-sm font-medium text-kesari-800"
                data-testid="in-app-navigation"
              >
                {tr(T.turnByTurn, lang)}
              </a>
            ) : null}
            {activeDelivery.cashToCollectPaise != null ? (
              <p className="rounded-lg bg-kesari-50 p-2 font-semibold text-kesari-800" data-testid="cash-to-collect">
                {tr(T.codCollect, lang)} <Money paise={activeDelivery.cashToCollectPaise} />
              </p>
            ) : null}
            {activeDelivery.distanceKm ? (
              <p className="text-ink-500">
                {tr(T.kmLeg, lang).replace("{km}", Number(activeDelivery.distanceKm).toFixed(1))}
                {activeDelivery.routeSource === "ROAD" ? tr(T.byRoad, lang) : ""}
              </p>
            ) : null}
            {activeDelivery.legDurationSeconds != null ? (
              <p className="text-ink-500" data-testid="rider-eta">
                {activeDelivery.pickupDurationSeconds != null && !activeDelivery.outForDeliveryAt
                  ? tr(T.etaShopThen, lang).replace("{n}", String(Math.max(1, Math.round(activeDelivery.pickupDurationSeconds / 60))))
                  : tr(T.etaAbout, lang)}
                {tr(T.etaCustomer, lang).replace("{n}", String(Math.max(1, Math.round(activeDelivery.legDurationSeconds / 60))))}
              </p>
            ) : null}
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {activeDelivery.status === "OFFERED" && offerEarn?.earnPaise != null ? (
              <div className="w-full">
                <YouEarn earnPaise={offerEarn.earnPaise} breakdown={offerEarn.breakdown} lang={lang} />
              </div>
            ) : null}
            {activeDelivery.status === "OFFERED" && !rejecting ? (
              <>
                <Button size="sm" disabled={busy} onClick={() => act("accept")}>
                  {tr(T.accept, lang)}
                </Button>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => setRejecting(true)}>
                  {tr(T.reject, lang)}
                </Button>
              </>
            ) : null}
            {activeDelivery.status === "OFFERED" && rejecting ? (
              <RejectReasonPicker
                lang={lang}
                busy={busy}
                onCancel={() => setRejecting(false)}
                onPick={(reasonCode, note) => {
                  setRejecting(false);
                  void act("reject", note ? { reasonCode, reason: note } : { reasonCode });
                }}
              />
            ) : null}
            {activeDelivery.status === "ACCEPTED" && !activeDelivery.arrivedAtShopAt ? (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => act("arrived_shop")}>
                {tr(T.arrivedShop, lang)}
              </Button>
            ) : null}
            {activeDelivery.status === "ACCEPTED" && pickupQr && activeDelivery.needsPickupCode ? (
              <PickupQrScanner deliveryOrderId={activeDelivery.id} onPickedUp={() => router.refresh()} lang={lang} />
            ) : null}
            {activeDelivery.status === "ACCEPTED" ? (
              <>
                {activeDelivery.needsPickupCode ? (
                  <CodeInput
                    label={tr(T.pickupCodeLabel, lang)}
                    value={code}
                    onChange={setCode}
                  />
                ) : null}
                <Button
                  size="sm"
                  disabled={busy || (activeDelivery.needsPickupCode && code.length !== 4)}
                  onClick={() => act("pickup", { pickupCode: code })}
                >
                  {tr(T.confirmPickup, lang)}
                </Button>
                <div className="w-full">
                  <DeliveryProofCapture deliveryOrderId={activeDelivery.id} uploaded={Boolean(activeDelivery.pickupPhotoUploaded)} kind="PICKUP" lang={lang} />
                </div>
              </>
            ) : null}
            {activeDelivery.status === "PICKED_UP" &&
            activeDelivery.needsPickupCode &&
            !activeDelivery.outForDeliveryAt ? (
              <Button size="sm" disabled={busy} onClick={() => act("start")}>
                {tr(T.startDelivery, lang)}
              </Button>
            ) : null}
            {activeDelivery.status === "PICKED_UP" &&
            (activeDelivery.outForDeliveryAt || !activeDelivery.needsPickupCode) &&
            !activeDelivery.arrivedAtCustomerAt ? (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => act("arrived_customer")}>
                {tr(T.arrivedCustomer, lang)}
              </Button>
            ) : null}
            {activeDelivery.status === "PICKED_UP" && activeDelivery.deliveryCodeLocked ? (
              <div className="w-full" data-testid="delivery-code-locked">
                <Alert tone="warning" title={tr(T.lockedTitle, lang)}>
                  {tr(T.lockedBody, lang)}
                </Alert>
              </div>
            ) : null}
            {activeDelivery.status === "PICKED_UP" &&
            !activeDelivery.deliveryCodeLocked &&
            (activeDelivery.outForDeliveryAt || !activeDelivery.needsPickupCode) ? (
              <>
                {activeDelivery.needsDeliveryOtp ? (
                  <CodeInput
                    label={tr(T.deliveryCodeLabel, lang)}
                    value={code}
                    onChange={setCode}
                  />
                ) : null}
                {activeDelivery.proofRequired ? (
                  <DeliveryProofCapture
                    deliveryOrderId={activeDelivery.id}
                    uploaded={Boolean(activeDelivery.proofUploaded)}
                    lang={lang}
                  />
                ) : null}
                {activeDelivery.signatureEnabled ? (
                  <div className="w-full">
                    <DeliverySignatureCapture
                      deliveryOrderId={activeDelivery.id}
                      uploaded={Boolean(activeDelivery.signatureUploaded)}
                      required={Boolean(activeDelivery.signatureRequired)}
                      captureGps={Boolean(activeDelivery.captureGps)}
                    />
                  </div>
                ) : null}
                {activeDelivery.cashToCollectPaise != null ? (
                  <label className="flex items-center gap-2 text-sm text-ink-700">
                    <input
                      type="checkbox"
                      checked={cashCollected}
                      onChange={(e) => setCashCollected(e.target.checked)}
                    />
                    {tr(T.collectedPre, lang)} <Money paise={activeDelivery.cashToCollectPaise} /> {tr(T.collectedPost, lang)}
                  </label>
                ) : null}
                <Button
                  size="sm"
                  disabled={
                    busy ||
                    (activeDelivery.needsDeliveryOtp && code.length !== 4) ||
                    (activeDelivery.cashToCollectPaise != null && !cashCollected) ||
                    (Boolean(activeDelivery.proofRequired) && !activeDelivery.proofUploaded) ||
                    (Boolean(activeDelivery.signatureRequired) && !activeDelivery.signatureUploaded)
                  }
                  onClick={() => act("deliver", { otp: code, cashCollected })}
                >
                  {tr(T.markDelivered, lang)}
                </Button>
              </>
            ) : null}
            {activeDelivery.status === "PICKED_UP" ? (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => setShowFail((v) => !v)}>
                {tr(T.couldNotDeliver, lang)}
              </Button>
            ) : null}
          </div>

          {showFail && activeDelivery.failureReasonList ? (
            <fieldset className="mt-3 space-y-2" data-testid="fail-reason-list">
              <legend className="text-sm font-medium text-ink-700">Why could the order not be delivered?</legend>
              {FAILURE_REASON_CODES.map((reasonCode) => (
                <label key={reasonCode} className="flex items-center gap-2 text-sm text-ink-700">
                  <input
                    type="radio"
                    name="fail-reason"
                    value={reasonCode}
                    checked={failCode === reasonCode}
                    onChange={() => setFailCode(reasonCode)}
                  />
                  {FAILURE_REASON_LABELS[reasonCode]}
                </label>
              ))}
              <input
                className="w-full rounded-lg border border-cream-200 px-3 py-2 text-sm"
                placeholder={failCode === "OTHER" ? "What happened? (required)" : "Add a note (optional)"}
                value={failReason}
                maxLength={280}
                onChange={(e) => setFailReason(e.target.value)}
                aria-label="Note about the failed delivery"
              />
              <Button
                size="sm"
                variant="danger"
                disabled={busy || !failCode || (failCode === "OTHER" && failReason.trim().length < 3)}
                onClick={() => act("fail", { reasonCode: failCode, ...(failReason.trim() ? { reason: failReason } : {}) })}
              >
                Report failed delivery
              </Button>
            </fieldset>
          ) : showFail ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <input
                className="min-w-0 flex-1 rounded-lg border border-cream-200 px-3 py-2 text-sm"
                placeholder={tr(T.failPlaceholder, lang)}
                value={failReason}
                onChange={(e) => setFailReason(e.target.value)}
                aria-label={tr(T.failAria, lang)}
              />
              <Button
                size="sm"
                variant="danger"
                disabled={busy || failReason.trim().length < 3}
                onClick={() => act("fail", { reason: failReason })}
              >
                {tr(T.reportFailed, lang)}
              </Button>
            </div>
          ) : null}
        </Card>
      ) : isOnline ? (
        <Card className="p-5 text-sm text-ink-500">{tr(T.waiting, lang)}</Card>
      ) : null}

      {activeReturnPickup ? (
        <ReturnPickupPanel pickup={activeReturnPickup} onDone={() => router.refresh()} lang={lang} />
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  );
}

const RETURN_PICKUP_LABEL: Record<string, Text> = {
  OFFERED: T.rpOffered,
  ACCEPTED: T.rpAccepted,
  EN_ROUTE: T.rpEnRoute,
};

/** A rider's live return pickup: accept, set off, take the goods with the customer's code, or report a problem. */
function ReturnPickupPanel({
  pickup,
  onDone,
  lang = "en",
}: {
  pickup: ActiveReturnPickupView;
  onDone: () => void;
  lang?: Lang;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [showFail, setShowFail] = useState(false);
  const [failReason, setFailReason] = useState("");

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/return-pickups/${pickup.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        setError(errorText(payload?.error?.message ?? tr(T.errAction, lang), lang, payload?.error?.code));
        return;
      }
      setCode("");
      setShowFail(false);
      onDone();
    } catch {
      setError(tr(T.errNoServer, lang));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5" data-testid="return-pickup-panel">
      <p className="text-xs font-semibold uppercase tracking-wide text-kesari-600">
        {RETURN_PICKUP_LABEL[pickup.status] ? tr(RETURN_PICKUP_LABEL[pickup.status], lang) : pickup.status}
      </p>
      <p className="mt-2 font-semibold text-ink-900">{tr(T.returnNo, lang).replace("{n}", pickup.returnNumber)}</p>
      <div className="mt-3 space-y-2 text-sm">
        <div>
          <p className="font-medium text-ink-700">{tr(T.collectFrom, lang)}</p>
          <p className="text-ink-500">{pickup.customerAddress ?? tr(T.addressOnOrder, lang)}</p>
          {pickup.customerAddress && pickup.status !== "EN_ROUTE" ? (
            <p className="text-xs text-ink-500">{tr(T.fullAddressSetOff, lang)}</p>
          ) : null}
          {pickup.customerNotes ? <p className="text-ink-500">{tr(T.note, lang)} {pickup.customerNotes}</p> : null}
          {pickup.scheduledFor ? (
            <p className="text-ink-500">
              {tr(T.readyFrom, lang).replace(
                "{when}",
                new Date(pickup.scheduledFor).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }),
              )}
            </p>
          ) : null}
          {pickup.navigationUrl ? (
            <a href={pickup.navigationUrl} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-kesari-700 underline">
              {tr(T.navCustomer, lang)}
            </a>
          ) : null}
        </div>
        <div>
          <p className="font-medium text-ink-700">{tr(T.bringBack, lang)}</p>
          <p className="text-ink-500">
            {pickup.shopName} — {pickup.shopAddress}
          </p>
          {pickup.shopNavigationUrl ? (
            <a href={pickup.shopNavigationUrl} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-kesari-700 underline">
              {tr(T.navShop, lang)}
            </a>
          ) : null}
        </div>
        <p className="text-ink-500">{pickup.itemSummary}</p>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {pickup.status === "OFFERED" ? (
          <>
            <Button size="sm" disabled={busy} onClick={() => act({ action: "accept" })}>
              {tr(T.accept, lang)}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => act({ action: "reject" })}>
              {tr(T.reject, lang)}
            </Button>
          </>
        ) : null}
        {pickup.status === "ACCEPTED" ? (
          <Button size="sm" disabled={busy} onClick={() => act({ action: "start" })}>
            {tr(T.setOff, lang)}
          </Button>
        ) : null}
        {pickup.status === "EN_ROUTE" ? (
          <>
            <CodeInput label={tr(T.handoverLabel, lang)} value={code} onChange={setCode} />
            <Button size="sm" disabled={busy || code.length !== 4} onClick={() => act({ action: "pickup", code })}>
              {tr(T.confirmPickup, lang)}
            </Button>
          </>
        ) : null}
        {pickup.status === "ACCEPTED" || pickup.status === "EN_ROUTE" ? (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => setShowFail((v) => !v)}>
            {tr(T.couldNotCollect, lang)}
          </Button>
        ) : null}
      </div>

      {showFail ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            className="min-w-0 flex-1 rounded-lg border border-cream-200 px-3 py-2 text-sm"
            placeholder={tr(T.rpFailPlaceholder, lang)}
            value={failReason}
            onChange={(e) => setFailReason(e.target.value)}
            aria-label={tr(T.rpFailAria, lang)}
          />
          <Button
            size="sm"
            variant="danger"
            disabled={busy || failReason.trim().length < 3}
            onClick={() => act({ action: "fail", reason: failReason })}
          >
            {tr(T.reportFailedPickup, lang)}
          </Button>
        </div>
      ) : null}
      {error ? (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}
    </Card>
  );
}

/**
 * NEW-007: the photo at the door. Opens the camera on a phone; the image is
 * shrunk and re-encoded in the browser (which also drops location metadata)
 * and checked again on the server.
 */
function DeliveryProofCapture({
  deliveryOrderId,
  uploaded,
  kind = "DELIVERY",
  lang = "en",
}: {
  deliveryOrderId: string;
  uploaded: boolean;
  /** Gig worker flow (feature 9): PICKUP is the optional photo of the parcel at the shop. */
  kind?: "PICKUP" | "DELIVERY";
  lang?: Lang;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.append("file", await shrinkImage(file), kind === "PICKUP" ? "pickup.jpg" : "delivery.jpg");
      body.append("kind", kind);
      const response = await fetch(`/api/delivery-orders/${deliveryOrderId}/proof`, { method: "POST", body });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(errorText(payload?.error?.message ?? tr(T.errPhoto, lang), lang, payload?.error?.code));
        return;
      }
      router.refresh();
    } catch {
      setError(tr(T.errPhotoNet, lang));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1 text-sm" data-testid={kind === "PICKUP" ? "pickup-proof" : "delivery-proof"}>
      <label className="block font-medium text-ink-700">
        {tr(
          kind === "PICKUP" ? (uploaded ? T.pickupPhotoDone : T.pickupPhoto) : uploaded ? T.doorPhotoDone : T.doorPhoto,
          lang,
        )}
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          disabled={busy}
          onChange={(e) => void upload(e.target.files)}
          className="mt-1 block w-full text-xs"
        />
      </label>
      {busy ? <p className="text-xs text-ink-500">{tr(T.uploading, lang)}</p> : null}
      {error ? <p className="text-xs text-red-700">{error}</p> : null}
    </div>
  );
}

/**
 * Module 4 (rule deliveryProof.signatureEnabled): the customer signs on the
 * rider's phone before "Mark delivered". Uploaded as a PNG through the proof
 * endpoint (kind SIGNATURE, optional signer name) — stored privately like the
 * photo and checked again on the server.
 */
function DeliverySignatureCapture({
  deliveryOrderId,
  uploaded,
  required,
  captureGps,
}: {
  deliveryOrderId: string;
  uploaded: boolean;
  required: boolean;
  captureGps: boolean;
}) {
  const router = useRouter();
  const [strokes, setStrokes] = useState<SignatureStroke[]>([]);
  const [signerName, setSignerName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(!uploaded);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const png = await signatureToPngBlob(strokes);
      if (!png) {
        setError("Ask the customer to sign in the box first.");
        return;
      }
      const body = new FormData();
      body.append("file", png, "signature.png");
      body.append("kind", "SIGNATURE");
      if (signerName.trim()) body.append("signerName", signerName.trim());
      const position = captureGps ? await currentPositionOrNull() : null;
      if (position) {
        body.append("latitude", String(position.latitude));
        body.append("longitude", String(position.longitude));
      }
      const response = await fetch(`/api/delivery-orders/${deliveryOrderId}/proof`, { method: "POST", body });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(payload?.error?.message ?? "Could not save the signature.");
        return;
      }
      setStrokes([]);
      setOpen(false);
      router.refresh();
    } catch {
      setError("Could not save the signature. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="delivery-signature">
        <span className="font-medium text-ink-700">Customer signature added ✓</span>
        <button type="button" className="text-sm text-kesari-700 underline" onClick={() => setOpen(true)}>
          Sign again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-cream-200 p-3" data-testid="delivery-signature">
      <SignaturePad
        value={strokes}
        onChange={setStrokes}
        disabled={busy}
        label={required ? "Customer signature (required)" : "Customer signature (optional)"}
      />
      <label className="block text-sm text-ink-700">
        Name of the person signing (optional)
        <input
          className="mt-1 w-full rounded-lg border border-cream-200 px-3 py-2 text-sm"
          value={signerName}
          maxLength={80}
          autoComplete="off"
          onChange={(e) => setSignerName(e.target.value)}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy || !hasInk(strokes)} onClick={() => void save()}>
          {busy ? "Saving…" : "Save signature"}
        </Button>
        {uploaded ? (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
            Keep the saved signature
          </Button>
        ) : null}
      </div>
      {error ? <p className="text-xs text-red-700">{error}</p> : null}
    </div>
  );
}
