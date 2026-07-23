import { loginGoogle } from "./firebase-config.js";

document
.getElementById("googleLoginBtn")
.addEventListener("click", async ()=>{

    const user = await loginGoogle();

    if(user){

        console.log(user);

    }

});