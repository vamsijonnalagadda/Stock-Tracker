export const POWER_KEYWORDS = [
    // --- EMERGENCY & GEOPOLITICAL ---
    "WAR", "ATTACK", "CONFLICT", "MILITARY", "STRIKE", "GEOPOLITICAL", "TRUMP", "WHITE HOUSE", "ELECTION", "TARIFFS",

    // --- MACRO, LABOR & FED ---
    "JOBS", "UNEMPLOYMENT", "PAYROLLS", "FED", "RATE HIKE", "RATE CUT", "INFLATION", "CPI", "PCE", "DOLLAR INDEX", "DXY", "CURRENCY",

    // --- COMMODITIES, METALS & ENERGY ---
    "GOLD", "SILVER", "METALS", "COPPER", "OIL", "CRUDE", "NATURAL GAS",

    // --- FIXED INCOME & DEBT ---
    "TREASURY", "YIELD", "10-YEAR", "BONDS", "DEBT",

    // --- REGULATORY, CORPORATE & TECH ---
    "APPROVAL", "FDA", "SEC", "ANTITRUST", "EARNINGS", "MERGER", "ACQUISITION", "IPO", "BANKRUPTCY", "GUIDANCE", "AI", "SEMICONDUCTOR", "CHIP", "HOUSING", "RETAIL",

    // --- MARKET DYNAMICS ---
    "SELL-OFF", "RALLY", "CORRECTION", "VOLATILITY", "VIX", "UPGRADE", "DOWNGRADE", "BREAKING", "URGENT", "CRYPTO", "BITCOIN"
];

export const WEIGHTS = {
    EMERGENCY: 75,
    MACRO: 55,
    CORPORATE: 45,
    SECTOR: 30,
    RELIABILITY: 40
};

export const GOLD_STANDARD_SOURCES = [
    "BLOOMBERG", "REUTERS", "CNBC", "WSJ", "FINANCIAL TIMES",
    "BARRONS", "MARKETWATCH", "NDTV PROFIT", "FOX NEWS", "CNN",
    "FOX BUSINESS", "NBC NEWS", "BBC", "NEW YORK TIMES", "NY TIMES"
];

export function isGoldStandardSource(source) {
    const src = String(source || '').toUpperCase();
    return GOLD_STANDARD_SOURCES.some(s => src.includes(s));
}

export function getKeywordWeight(headline, source) {
    const title = String(headline || '').toUpperCase();
    let weight = 0;

    if (["WAR", "ATTACK", "CONFLICT", "STRIKE", "BREAKING", "URGENT", "BANKRUPTCY"].some(k => title.includes(k))) {
        weight += WEIGHTS.EMERGENCY;
    }

    if (["FED", "JOBS", "PAYROLLS", "INFLATION", "CPI", "PCE", "TREASURY", "YIELD", "TARIFFS", "TRUMP"].some(k => title.includes(k))) {
        weight += WEIGHTS.MACRO;
    }

    if (["EARNINGS", "GUIDANCE", "APPROVAL", "FDA", "SEC", "ANTITRUST", "MERGER", "ACQUISITION", "IPO"].some(k => title.includes(k))) {
        weight += WEIGHTS.CORPORATE;
    }

    if (["GOLD", "SILVER", "METALS", "OIL", "CRUDE", "NATURAL GAS", "AI", "SEMICONDUCTOR", "CHIP", "CRYPTO"].some(k => title.includes(k))) {
        weight += WEIGHTS.SECTOR;
    }

    if (["SELL-OFF", "RALLY", "CORRECTION", "VOLATILITY", "VIX", "UPGRADE", "DOWNGRADE"].some(k => title.includes(k))) {
        weight += 20;
    }

    if (isGoldStandardSource(source)) {
        weight += WEIGHTS.RELIABILITY;
    }

    return weight;
}
