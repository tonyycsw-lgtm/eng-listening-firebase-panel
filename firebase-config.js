// firebase-config.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-app.js";
import { 
    getAuth, 
    signOut, 
    onAuthStateChanged, 
    GoogleAuthProvider, 
    signInWithPopup,
    signInAnonymously
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js";
import { 
    getFirestore, 
    doc, 
    getDoc, 
    setDoc, 
    updateDoc, 
    collection, 
    query, 
    where, 
    getDocs,
    addDoc,
    writeBatch,
    increment,
    arrayUnion,
    arrayRemove,
    onSnapshot
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyDy_F3TB66nFgGoKEWODatn8QfucazWusU",
    authDomain: "eng-listening-panel.firebaseapp.com",
    projectId: "eng-listening-panel",
    storageBucket: "eng-listening-panel.firebasestorage.app",
    messagingSenderId: "23231205702",
    appId: "1:23231205702:web:1c6c325ff08aa8ca21d547"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { 
    auth, 
    db, 
    doc, 
    getDoc, 
    setDoc, 
    updateDoc, 
    collection, 
    query, 
    where, 
    getDocs,
    addDoc,
    writeBatch,
    signOut, 
    onAuthStateChanged, 
    GoogleAuthProvider, 
    signInWithPopup,
    signInAnonymously,
    increment,
    arrayUnion,
    arrayRemove,
    onSnapshot
};