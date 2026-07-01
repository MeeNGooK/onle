export const firebaseConfig = {
  apiKey: "AIzaSyC9cg2J-nzqOWgWQ00LuO7R7b9oWEGoJxE",
  authDomain: "onle-6e4a1.firebaseapp.com",
  projectId: "onle-6e4a1",
  storageBucket: "onle-6e4a1.firebasestorage.app",
  messagingSenderId: "190716573777",
  appId: "1:190716573777:web:28c04032b7df509a436070",
};

export const firebaseEnabled = Boolean(
  firebaseConfig.apiKey &&
    firebaseConfig.authDomain &&
    firebaseConfig.projectId &&
    firebaseConfig.appId,
);
