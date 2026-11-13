# Anne's Stage for Android

The Android app is the Anne's Stage web app (TypeScript/Vite, built into `dist/`) wrapped with
[Capacitor 8](https://capacitorjs.com/). The native project lives in `android/` and is committed;
`npx cap sync android` copies the web build into it and regenerates the Capacitor plugin glue.

| Item | Value |
| --- | --- |
| Application ID | `io.github.socrtwo.quillstage` |
| minSdk / targetSdk / compileSdk | 24 (Android 7.0) / 36 / 36 (`android/variables.gradle`) |
| versionName | `version` from the root `package.json` |
| versionCode | `VERSION_CODE` environment variable, default `1` (CI uses the workflow run number) |
| Java / Gradle | JDK 21, Gradle wrapper 8.14.3, Android Gradle Plugin 8.13 |

## Build locally

Prerequisites: Node.js 22, JDK 21, and the Android SDK (Android Studio installs it; set `ANDROID_HOME`
or let Android Studio write `android/local.properties`).

```bash
npm ci
npm run build              # web app -> dist/
npx cap sync android       # copy dist/ into android/ and update native plugins
```

Then either:

- **Android Studio:** `npx cap open android` (or open the `android/` folder), pick a device, press Run.
- **Command line:**

  ```bash
  cd android
  ./gradlew assembleDebug                    # app/build/outputs/apk/debug/app-debug.apk
  ./gradlew assembleRelease bundleRelease    # release APK + AAB (see signing below)
  ./gradlew installDebug                     # install on a connected device / emulator
  ```

`npm run android:build` runs build + sync + `assembleRelease` in one go.

Run `npx cap sync android` again after every web build; the web assets in
`android/app/src/main/assets/public/` and `android/capacitor-cordova-android-plugins/` are generated
and git-ignored.

## Continuous integration and releases

`.github/workflows/android.yml` runs on every push to a branch, on pull requests and manually
(`workflow_dispatch`). Documentation-only changes do not trigger it. The Release workflow
(`release.yml`) also calls it for tagged and `[release]` builds. Steps:

1. `npm ci`, `npm run typecheck`, `npm test`, `npm run build` (all required to pass).
2. JDK 21 (Temurin), Gradle cache, Android SDK (`android-actions/setup-android@v3`).
3. `npx cap sync android`.
4. Decode the release keystore from secrets, if configured.
5. `./gradlew assembleRelease bundleRelease`.
6. Upload `QuillStage-<version>.apk` and `QuillStage-<version>.aab` as workflow artifacts
   (Actions run page -> *Artifacts*).

Publishing:

- **Tagged release:** bump `version` in `package.json`, commit, then
  `git tag v0.2.0 && git push origin v0.2.0`. The Release workflow builds every platform and publishes
  one GitHub Release named after the tag, with the APK, AAB and `SHA256SUMS.txt` among its files (tags
  containing `-`, e.g. `v0.2.0-beta.1`, are marked prerelease). A commit whose message contains
  `[release]` does the same without a tag, as a prerelease. The Android build warns if the tag does not
  match `package.json`.
- **Prerelease from any branch, without tagging:** Actions -> *Android* -> *Run workflow*, choose the
  branch, tick **prerelease**. This publishes a GitHub prerelease called
  `Anne's Stage <version> (Android build <run number>)` under the tag `v<version>-android-build.<run number>` pointing at
  that commit.

## Signing

`android/app/build.gradle` reads these environment variables:

| Variable | Meaning |
| --- | --- |
| `ANDROID_KEYSTORE_PATH` | Absolute path to the `.jks` keystore |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore (store) password |
| `ANDROID_KEY_ALIAS` | Key alias inside the keystore |
| `ANDROID_KEY_PASSWORD` | Key password (defaults to the store password if empty) |

If `ANDROID_KEYSTORE_PATH` is not set (or the file does not exist) the **release build is signed with
the Android debug key**. That APK installs fine for sideloading and testing, but:

- Google Play rejects debug-signed bundles - you need a real upload key for the store.
- Debug keys differ between machines/runners, so a debug-signed build cannot be installed *over* a build
  signed with a different key (uninstall first). Configure a real key once you share builds with others.

### Create a keystore (once)

```bash
keytool -genkeypair -v \
  -keystore quillstage-release.jks \
  -alias quillstage \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=Anne's Stage, O=Anne's Stage, C=US"
```

Keep the `.jks` file and its passwords somewhere safe and **never commit it** (`*.jks` and `*.keystore`
are git-ignored). If you lose it you can no longer publish updates under the same signature.

### Add it to GitHub

```bash
base64 -w 0 quillstage-release.jks > quillstage-release.jks.b64   # macOS: base64 -i quillstage-release.jks
```

Repository -> *Settings* -> *Secrets and variables* -> *Actions* -> *New repository secret*:

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | contents of `quillstage-release.jks.b64` |
| `ANDROID_KEYSTORE_PASSWORD` | the store password |
| `ANDROID_KEY_ALIAS` | `quillstage` (or the alias you chose) |
| `ANDROID_KEY_PASSWORD` | the key password |

The workflow decodes the keystore to `$RUNNER_TEMP` and exports `ANDROID_KEYSTORE_PATH`; release
outputs are then properly signed. For Google Play, enroll in Play App Signing and use this key as the
upload key.

Signing locally works the same way:

```bash
export ANDROID_KEYSTORE_PATH=$PWD/quillstage-release.jks ANDROID_KEYSTORE_PASSWORD=... \
       ANDROID_KEY_ALIAS=quillstage ANDROID_KEY_PASSWORD=...
cd android && ./gradlew assembleRelease bundleRelease
```

## Install (sideload) the APK

1. Download `QuillStage-<version>.apk` from a GitHub Release (or a workflow run's artifacts - those are
   zipped, unzip first).
2. On the phone, open the APK from the browser or file manager. Android asks to allow installing apps
   from that source (*Settings -> Apps -> Special app access -> Install unknown apps*); allow it.
3. Or from a computer with USB debugging: `adb install -r QuillStage-<version>.apk`.

If the installer says the package conflicts with an existing one, the installed copy was signed with a
different key - uninstall it first (this deletes app data).

The `.aab` is for Google Play only; it cannot be installed directly.

## What the Android app integrates with

- **Open / Save As** use the system file picker (Storage Access Framework), so files in Drive,
  Dropbox, SD cards, etc. work and no storage permission is needed. Ctrl+S writes back to the same
  presentation via a persisted URI permission.
- **Open with Anne's Stage** (`ACTION_VIEW`) for `.pptx`, `.pptm`, `.ppsx`, `.ppsm`, `.potx`, `.potm`, `.ppt`, `.pps`, `.pot`,
  `.odp`, `.otp`, `.fodp`, `.sxi`, `.md`, `.qsp` and `.qspe`. Files are matched by MIME type
  (`…presentationml.presentation`, `…presentationml.slideshow`, `…presentationml.template`, `application/vnd.ms-powerpoint`,
  `…opendocument.presentation`, `text/markdown`, `application/x-quillstage`) and, for providers that report a generic type, by extension.
- **Share to Anne's Stage** (`ACTION_SEND`) for the same types. Text shared without a file arrives
  as a `.txt` file and opens through the text import.
- **Print** goes through Android's print service, which also offers *Save as PDF*.
- **Share** sends the exported file to any app via the share sheet.
- The activity is `singleTask`, so opening another file while Anne's Stage runs delivers it to the running
  instance (`fileOpened` event).

## Native plugin API (`QuillNative`)

Implemented in `android/app/src/main/java/io/github/socrtwo/quillstage/QuillNativePlugin.java`,
registered in `MainActivity`, consumed by `src/platform/native.ts`. All file contents cross the bridge as
base64 strings (no line breaks); `data:` URL prefixes are tolerated on input.

| Method | Arguments | Resolves with |
| --- | --- | --- |
| `openDocument` | `{ mimeTypes: string[] }` | `{ uri, name, mime, data }` or `{ canceled: true }` |
| `saveAs` | `{ name, mime, data }` | `{ uri, name }` or `{ canceled: true }` |
| `writeUri` | `{ uri, data }` | `{ ok: true }` (rejects with a message on failure) |
| `readUri` | `{ uri }` | `{ uri, name, mime, data }` |
| `print` | `{ jobName }` | nothing (print dialog shown) |
| `share` | `{ name, mime, data, title? }` | nothing (share sheet shown) |
| `getLaunchFile` | - | `{ uri, name, mime, data }`, or `{}` if the app was not opened with a file. Consumed once. Text shared without a file arrives as `{ name: "….txt", mime: "text/plain", data }` with no `uri`. |
| `keepAwake` | `{ on: boolean }` | nothing |
| event `fileOpened` | - | same payload as `getLaunchFile`, for files opened/shared while the app is running (kept until a listener subscribes) |

Notes:

- `openDocument` and `saveAs` take a persistable read/write permission when the provider allows it, so
  the returned `uri` keeps working for `writeUri` / `readUri` after restarts. URIs from "Open with" may
  be read-only or temporary; if `writeUri` rejects, fall back to `saveAs`.
- Writes use mode `"wt"` (truncate), falling back to `"w"` for providers that do not support it.
- File I/O runs on a background thread; very large presentations are limited by memory (files over the plugin's size limit are refused) because they are
  passed to the WebView as one base64 string.

## App icon

The launcher icon is the Anne's Office suite icon for this app: a white presentation screen with a bar chart and a white quill on a
green tile. Its sources are `resources/icon.svg` (the full tile), `resources/icon-foreground.svg` (the
adaptive-icon foreground, artwork inside the safe zone) and `resources/icon-background.txt` (the
adaptive background color, `#1E7A46`). `node scripts/gen-android-icons.mjs` writes from them:

- `resources/icon-square.svg` (full bleed), `resources/icon-512.png`, `public/favicon.svg`
- the adaptive icon layers: `res/drawable/ic_launcher_background.xml` (solid color) and the bitmaps
  `res/drawable-*dpi/ic_launcher_{foreground,monochrome}.png` (the monochrome layer is the artwork as a
  white silhouette for Android 13+ themed icons)
- the background color `res/values/ic_launcher_background.xml` (also the splash color)
- legacy PNGs `res/mipmap-*/ic_launcher{,_round}.png` (for Android 7.x) rendered with Playwright Chromium

Replace the three source files and run `npm run icons` (it also renders the iOS, desktop and web icons);
do not hand-edit the generated files. The launch screen (`res/drawable/splash.xml`) shows the foreground
on the background color.
