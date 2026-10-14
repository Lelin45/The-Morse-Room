# Morse Code Nepal: Google Play upload files

The app name and descriptions are ready to copy from the three text files. The 16 screenshots show the app's exact bundled interface rendered in Chrome with touch input. The capture manifest records this source; these are app-content captures. The filenames identify the section and device size.

| Play Console field | File or folder |
| --- | --- |
| App name | [app-name.txt](app-name.txt) |
| Short description | [short-description.txt](short-description.txt) |
| Full description | [full-description.txt](full-description.txt) |
| App icon | [icon.png](icon.png), 512 x 512 |
| Feature graphic | [feature-graphic.png](feature-graphic.png), 1024 x 500 |
| Phone screenshots | [screenshots/phone](screenshots/phone/), 1080 x 1920 |
| 7-inch tablet screenshots | [screenshots/tablet-7](screenshots/tablet-7/), landscape 16:9 |
| 10-inch tablet screenshots | [screenshots/tablet-10](screenshots/tablet-10/), landscape 16:9 |
| Optional video | [video](video/) |

The video is a 24-second slideshow of the same app-content captures. Upload it to your YouTube account as Public or Unlisted, keep advertising off and do not age-restrict it, then paste its YouTube URL into Play Console. The video has no audio.

## Public policy links

- Privacy Policy: https://learnmorse.lelinadhikari.com.np/privacy.html
- Terms and Conditions: https://learnmorse.lelinadhikari.com.np/terms.html
- Account deletion: https://learnmorse.lelinadhikari.com.np/delete-account.html

## App access

Learn, Practice and Codes do not require sign-in. Chat is the restricted area. The reviewer should tap Chat, then Review access, and use the credentials supplied privately in Play Console. The review account opens test conversations and cannot access real users' accounts. See [App access instructions](APP-ACCESS.md).

## Asset requirements

The icon is a full-square sRGB PNG with no external rounded mask or shadow. The feature graphic uses the app's existing dit/dah brand. Image dimensions, byte sizes and text lengths are listed in the asset manifest.

Rebuild the graphics with `node scripts/store-graphics.mjs` and validate the upload files with `node scripts/store-package.mjs`. These commands use the mobile project's Sharp dependency; install it with `npm ci --prefix mobile` first if needed.

[Google Play preview asset guidance](https://support.google.com/googleplay/android-developer/answer/9866151), [icon specifications](https://developer.android.com/distribute/google-play/resources/icon-design-specifications), [metadata policy](https://support.google.com/googleplay/android-developer/answer/9898842).
