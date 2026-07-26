/**
 * Reference figures for Karnataka's 30 districts, from Census of India 2011.
 *
 * These are REAL. Everything else in the demo dataset is synthetic and seeded,
 * but crime figures only mean something against a real denominator — a raw count
 * for Bengaluru Urban (9.6M people) and Kodagu (554k) are not comparable, and a
 * platform that showed them side by side would be lying. Per §7.3, the
 * socio-economic layer is exactly this: Census indicators used as context.
 *
 * `stations` is an approximate count of police stations per district and is
 * indicative rather than official.
 */
export interface CensusRow {
  name: string
  population: number
  urbanPct: number
  literacyPct: number
  stations: number
}

export const CENSUS_2011: CensusRow[] = [
  { name: 'Bengaluru Urban', population: 9621551, urbanPct: 90.9, literacyPct: 87.7, stations: 118 },
  { name: 'Belagavi', population: 4779661, urbanPct: 25.1, literacyPct: 73.5, stations: 62 },
  { name: 'Mysuru', population: 3001127, urbanPct: 41.5, literacyPct: 72.8, stations: 48 },
  { name: 'Tumakuru', population: 2678980, urbanPct: 22.3, literacyPct: 75.1, stations: 44 },
  { name: 'Kalaburagi', population: 2566326, urbanPct: 32.6, literacyPct: 64.9, stations: 41 },
  { name: 'Ballari', population: 2452595, urbanPct: 37.4, literacyPct: 67.4, stations: 38 },
  { name: 'Vijayapura', population: 2177331, urbanPct: 23.4, literacyPct: 67.2, stations: 34 },
  { name: 'Dakshina Kannada', population: 2089649, urbanPct: 47.7, literacyPct: 88.6, stations: 39 },
  { name: 'Davanagere', population: 1945497, urbanPct: 32.3, literacyPct: 75.7, stations: 30 },
  { name: 'Raichur', population: 1928812, urbanPct: 23.1, literacyPct: 59.6, stations: 31 },
  { name: 'Bagalkote', population: 1889752, urbanPct: 27.4, literacyPct: 68.8, stations: 29 },
  { name: 'Dharwad', population: 1847023, urbanPct: 56.8, literacyPct: 80.0, stations: 36 },
  { name: 'Mandya', population: 1805769, urbanPct: 16.0, literacyPct: 70.4, stations: 28 },
  { name: 'Hassan', population: 1776421, urbanPct: 18.7, literacyPct: 75.9, stations: 30 },
  { name: 'Shivamogga', population: 1752753, urbanPct: 35.4, literacyPct: 80.5, stations: 33 },
  { name: 'Bidar', population: 1703300, urbanPct: 25.5, literacyPct: 70.5, stations: 26 },
  { name: 'Chitradurga', population: 1659456, urbanPct: 19.9, literacyPct: 73.7, stations: 25 },
  { name: 'Haveri', population: 1597668, urbanPct: 21.4, literacyPct: 77.6, stations: 24 },
  { name: 'Kolar', population: 1536401, urbanPct: 30.0, literacyPct: 74.3, stations: 27 },
  { name: 'Uttara Kannada', population: 1437169, urbanPct: 31.0, literacyPct: 84.1, stations: 32 },
  { name: 'Koppal', population: 1389920, urbanPct: 16.8, literacyPct: 68.1, stations: 21 },
  { name: 'Chikkaballapura', population: 1255104, urbanPct: 22.2, literacyPct: 69.8, stations: 22 },
  { name: 'Udupi', population: 1177361, urbanPct: 28.5, literacyPct: 86.2, stations: 25 },
  { name: 'Yadgir', population: 1174271, urbanPct: 17.0, literacyPct: 51.8, stations: 18 },
  { name: 'Chikkamagaluru', population: 1137961, urbanPct: 19.5, literacyPct: 79.2, stations: 24 },
  { name: 'Ramanagara', population: 1082636, urbanPct: 24.1, literacyPct: 69.2, stations: 21 },
  { name: 'Gadag', population: 1064570, urbanPct: 35.6, literacyPct: 75.1, stations: 19 },
  { name: 'Chamarajanagara', population: 1020791, urbanPct: 17.2, literacyPct: 61.4, stations: 18 },
  { name: 'Bengaluru Rural', population: 990923, urbanPct: 27.6, literacyPct: 77.9, stations: 20 },
  { name: 'Kodagu', population: 554519, urbanPct: 14.5, literacyPct: 82.6, stations: 15 },
]


export const KARNATAKA_STATIONS = CENSUS_2011.reduce((a, r) => a + r.stations, 0)
