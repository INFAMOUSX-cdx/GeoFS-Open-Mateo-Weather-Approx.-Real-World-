# GeoFS Open-Meteo Weather Override

A Tampermonkey userscript that feeds **live real-world weather from [Open-Meteo](https://open-meteo.com/)** into [GeoFS](https://www.geo-fs.com/): real winds at every altitude (including the jet stream), gusts, turbulence, visibility, pressure, temperature, rain/snow and thunderstorms. **Clouds and time of day are never touched** and stay under GeoFS's control.

> Unofficial. Not affiliated with or endorsed by GeoFS or Open-Meteo. GeoFS's weather code is undocumented, so a GeoFS update can break this script.

## Features

- **Real winds aloft.** GeoFS normally applies one wind to every altitude. This script fetches Open-Meteo winds at 13 pressure levels (1000 to 150 hPa, roughly the surface to FL450) and installs about 29 interpolated 500 m wind layers, so you get a proper jet stream on transoceanic flights.
- **Keeps the airport METAR on the ground.** By default the surface wind stays GeoFS's own METAR wind and the model wind is blended in above it (`surfaceWind: 'metar'`).
- **Survives GeoFS's real-time weather refresh.** The script hooks GeoFS's weather functions, so a METAR update can't overwrite the injected values.
- **Calm by design.** Refetches are infrequent (every 30 min or 500 km), and a deadband means small forecast changes don't make the wind jump mid-flight.
- **On-screen panel** with the surface wind, the wind the sim is applying at your current altitude, the strongest wind aloft, temperature, QNH, visibility and precipitation.
- **Flight recorder.** Press **Log** to copy a time series of position, altitude, heading, ground speed, wind and headwind component, handy for bug reports.

## What it overrides

| Overridden with Open-Meteo data | Never touched |
|---|---|
| Wind at altitude (jet stream), gusts, turbulence | Clouds |
| Visibility | Time of day / date / season |
| Sea-level pressure and temperature | |
| Rain / snow amount, thunderstorms | |

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
   - **Chrome / Edge:** newer Tampermonkey versions need **Developer Mode** turned on at `chrome://extensions` (or `edge://extensions`) before any userscript will run.
2. Install the script (link to your Greasy Fork / raw GitHub file here).
3. Open [GeoFS](https://www.geo-fs.com/geofs.php) and start a flight. A small **"Open-Meteo Override"** panel appears bottom-left within a few seconds.

## The panel

| Row | Meaning |
|---|---|
| Surface (METAR) | The surface wind the sim is using (GeoFS's METAR wind by default) |
| Model 10 m wind | Open-Meteo's own surface estimate, for comparison |
| Sim wind here | The wind GeoFS is applying at your current altitude, as direction-from / knots |
| Winds aloft | Strongest wind in the installed profile and its flight level |
| Wind layers | How many wind layers are installed |
| Clouds / time | Always "GeoFS (untouched)" |

Buttons: **Inject ON/OFF** (OFF hands weather back to GeoFS), **Refresh** (fetch and apply immediately), **Dump** (print debug info to the console), **Log** (copy the flight recorder).

## Configuration

Edit the `CFG` block at the top of the script.

| Option | Default | Meaning |
|---|---|---|
| `refreshMs` | `30 min` | Maximum age of the data before refetching |
| `moveThresholdKm` | `500` | Refetch after flying this far from the last fetch point |
| `deadbandKt` / `deadbandDeg` | `3` / `10` | A refetch only changes the sim's wind if a layer moved more than this |
| `surfaceWind` | `'metar'` | `'metar'` keeps GeoFS's airport wind on the ground; `'openmeteo'` uses the model's surface wind |
| `model` | `''` | Open-Meteo model, e.g. `'icon_seamless'`, `'gfs_seamless'`, `'ecmwf_ifs025'` (empty = best match) |
| `windDirOffset` | `0` | Degrees added to every wind direction (use `180` if the sim turns out to be inverted) |
| `layerStepM` | `500` | Thickness of the interpolated wind layers |
| `inject.*` | all `true` | Switch individual categories on or off |
| `logEveryMs` / `logMax` | `20000` / `600` | Flight recorder sampling interval and length |

## Known limitations

- **Model data, not observations.** Open-Meteo is a weather model on a grid. Near the ground it can differ from an airport METAR by several knots and tens of degrees, especially in light winds. That's why the airport METAR stays on the ground by default.
- **Winds aloft are a forecast for the current hour.** Real jet-stream speeds vary day to day (often 80 to 150 kt in winter, lower in summer).
- **Unofficial hooks.** The script depends on GeoFS's internal `weather` object (`initWind`, `windLayers`, `Wind`, `set`, `generateDefinition`). If GeoFS changes it, the script may stop working. Open an issue with the output of **Dump** and the console log.
- **Precipitation and thunderstorm scaling is approximate.** It uses GeoFS's own value ranges when available, otherwise 0 to 1.
- **Client-side only.** Nothing is sent to other players, and the weather you see may differ from theirs in multiplayer.

## Privacy

The script sends your aircraft's **approximate latitude and longitude (4 decimals)** to `api.open-meteo.com` to fetch the weather. Nothing else is sent anywhere and there is no tracking. The only thing stored locally is your panel preferences (`localStorage`).

## Credits and licence

- Weather data by **[Open-Meteo.com](https://open-meteo.com/)**, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Open-Meteo's free API is for non-commercial use; see their [terms](https://open-meteo.com/en/terms).
- Script licensed under the MIT licence (see `LICENSE`).

## Changelog

- **2.4.1** Move-distance refetch threshold raised to 500 km.
- **2.4.0** Flight recorder and **Log** button.
- **2.3.x** Keep GeoFS's airport METAR wind at the surface and blend Open-Meteo in above it. METAR wind is read from GeoFS's own wind layer.
- **2.2.0** Less frequent refetching plus a deadband so small forecast changes don't disturb the flight.
- **2.1.0** Real winds aloft (pressure levels interpolated into GeoFS wind layers).
- **2.0.0** Hooks GeoFS's weather pipeline to override everything except clouds and time.
