# ONLE

ONLE is a lightweight planner web app with daily tasks, project progress, and a calendar heatmap.

## Firebase Setup

1. Create a Firebase project.
2. Add a Web app in Firebase Console.
3. Copy the Firebase web config into `firebase-config.js`.
4. Create a Firestore database.

Data is stored at:

```text
users/{nickname}
```

The app also keeps a local browser backup under:

```text
localStorage["onle:user:{nickname}"]
```

For the current nickname-only prototype, Firestore rules need to allow the app to read and write `users/{nickname}` documents. A fully open rule is convenient for testing but unsafe for public use. Before wider release, add real Firebase Auth or move writes behind a server/API.

## GitHub Pages

This app is static. Once pushed to GitHub, enable Pages from:

```text
Settings -> Pages -> Deploy from a branch -> main -> /root
```
