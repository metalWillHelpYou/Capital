// Инициализация Firebase — этот файл лежит в src/firebase.js.
// apiKey и остальные поля здесь не секретные: это обычная практика для
// клиентских Firebase-приложений — реальная защита данных обеспечивается
// правилами безопасности Firestore (firestore.rules), а не секретностью ключа.
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyA3uV8KCAsAOCd07WDyAD_gG3pfnnVlcac",
  authDomain: "capital-82776.firebaseapp.com",
  projectId: "capital-82776",
  storageBucket: "capital-82776.firebasestorage.app",
  messagingSenderId: "647406436509",
  appId: "1:647406436509:web:5bd72fa2de5196d1d69474",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
