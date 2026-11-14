# Data sources

All live sources need no API key unless noted. Each slide shows the credit line its licence asks for.

**Important:** check each provider's current terms before relying on them commercially. Licences change. The notes below reflect the terms as understood when these integrations were written (November 2026).

| Widget | Source | Licence / terms | Commercial use | Key? |
| --- | --- | --- | --- | --- |
| Weather (default) | [MET Norway Locationforecast](https://api.met.no/) | CC BY 4.0 / NLOD | ✅ with attribution; must send an identifying User-Agent and cache | No |
| Weather (optional) | [Open-Meteo](https://open-meteo.com/) | Data CC BY 4.0; **free API is non-commercial** | ⚠️ paid plan needed for commercial use | No |
| Place search | [OpenStreetMap Nominatim](https://nominatim.org/) | ODbL; [usage policy](https://operations.osmfoundation.org/policies/nominatim/): ≤ 1 request/s, identify yourself | ✅ with attribution (light use only) | No |
| Sunrise, sunset & moon | Calculated on the server | — | ✅ | No |
| Bank holidays | [GOV.UK bank holidays](https://www.gov.uk/bank-holidays.json) | Open Government Licence v3.0 | ✅ with attribution | No |
| Flood warnings | [Environment Agency real-time flood monitoring](https://environment.data.gov.uk/flood-monitoring/doc/reference) | Open Government Licence v3.0 | ✅ with attribution | No |
| Grid carbon | [Carbon Intensity API](https://carbonintensity.org.uk/) (NESO) | CC BY 4.0 | ✅ with attribution | No |
| Earthquakes | [USGS earthquake feeds](https://earthquake.usgs.gov/earthquakes/feed/) | Public domain | ✅ | No |
| Exchange rates | [Frankfurter](https://frankfurter.dev/) (ECB reference rates) | ECB data reusable with source acknowledged | ✅ with attribution | No |
| Online quiz questions | [Open Trivia Database](https://opentdb.com/) | CC BY-SA 4.0 | ✅ with attribution (share-alike) | No |
| Picture of the day | [Wikimedia feed API](https://api.wikimedia.org/wiki/Feed_API) / Commons | Per image (usually CC BY / CC BY-SA / PD); credit shown on screen | ✅ with the shown attribution | No |
| Born on this day, general history | Wikimedia feed API (Wikipedia) | CC BY-SA 4.0 | ✅ with attribution | No |
| Transport: live bus tracker | [Bus Open Data Service](https://data.bus-data.dft.gov.uk/) (DfT, England) | Open Government Licence v3.0 | ✅ with attribution | **Yes**, free |
| Transport: train departures | National Rail Darwin via a [Huxley2](https://github.com/jpsingleton/Huxley2) JSON proxy | Darwin open data terms (NRE) | ✅ under NRE's terms; a public Huxley2 instance may be unreliable, so run your own | Darwin token (free) for your own proxy |
| Transport: tube/rail status, London buses, London roads | [TfL Unified API](https://api.tfl.gov.uk/) | TfL open data terms: "Powered by TfL Open Data", contains OS data | ✅ with attribution; anonymous use is rate-limited | No (optional app key) |
| Transport: planes overhead | [adsb.lol](https://adsb.lol/) | ODbL | ✅ with attribution | No |
| News headlines | Any RSS/Atom feed you add | **Depends on the feed** | Only feeds you have rights to show | No |
| Calendar | Any iCal (.ics) feed you add | Depends on the calendar | Your own calendars | No |
| Live scores | ESPN public scoreboard JSON (unofficial) | **Undocumented; for personal / non-commercial use** | ⚠️ not for commercial use | No |
| Grassroots results, fixtures & tables | [The FA Full-Time](https://fulltime.thefa.com/) code-snippet feeds | Sanctioned club/league feed, issued per division or team from the Full-Time admin area. **Not an open API, and the public pages must not be scraped** — see [FULL_TIME.md](FULL_TIME.md) | ✅ for the club whose league issued the codes, with the shown credit | **Yes** — a snippet id (`lrcode`) per feed, from the club's own Full-Time login |

**Full-Time is decided but not yet built, and v1 does not wait for it.** The access route is settled
and written down in [FULL_TIME.md](FULL_TIME.md), and it still needs snippet codes from a club's own
Full-Time login plus one capture of a real feed response. **Nothing reads Full-Time today:** v1 ships
on the club's own file on the card (the `manual` source — see [CLUBHOUSE.md](CLUBHOUSE.md)), which
needs no provider's permission and no codes.

The bundled packs in `data/widgets/` (jokes, phrases, quiz, trivia, history, countries, emoji) were written for this project and ship under the repository's MIT licence.

## Not included yet (need registration)

- **Buses outside England:** Traveline Scotland and Wales open data. These are keyed and need a different API.
- **Traffic outside London:** the National Highways (England) DATEX II feed. It's free but needs registration.
- **Live flight boards for airports:** no free source that allows commercial use is available. Planes overhead is the open alternative.
