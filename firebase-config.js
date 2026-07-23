
import {
    getAuth,
    GoogleAuthProvider,
    signInWithPopup,
    signOut,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";

// Login Google
export async function loginGoogle() {

    try {

        const result = await signInWithPopup(auth, provider);

        return result.user;

    }

    catch(error){

        console.error(error);

        return null;

    }

}


// Logout
export async function logoutGoogle(){

    await signOut(auth);

}


// Estado da sessão
export function authListener(callback){

    onAuthStateChanged(auth, callback);

}


// Exportações
export {

    auth,

    provider

};