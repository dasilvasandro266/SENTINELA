const API_URL = '/api';

const isAdmin = (user) => user?.isAdmin === true || user?.isAdmin === 1 || user?.isAdmin === "1";

// Função para tratar sucesso de login (similar ao original)
export async function handleLoginSuccess(userData, token) {
    try {
        if (!userData || !userData.id) {
            console.error("❌ Usuário inválido retornado pelo login.");
            alert("Erro ao processar login. Tente novamente.");
            return;
        }

        // Persistir dados (similar ao original)
        localStorage.setItem("token", token);
        localStorage.setItem("user", JSON.stringify(userData));
        localStorage.setItem("userUID", userData.id);
        localStorage.setItem("userEmail", userData.email);
        localStorage.setItem("userDisplayName", userData.username);
        localStorage.setItem("userRole", isAdmin(userData) ? "admin" : "user");

        // Guardar dados adicionais do perfil
        localStorage.setItem("userData", JSON.stringify({
            nome_completo: userData.nome_completo,
            isAdmin: isAdmin(userData)
        }));

        // Redireciona com base no papel (igual ao original)
        if (isAdmin(userData)) {
            console.log("👑 Admin autenticado:", userData.id);
            window.location.href = "home.html";
        } else {
            console.log("🙋 Usuário autenticado:", userData.id);
            window.location.href = "home.html";
        }
    } catch (err) {
        console.error("❌ Erro ao processar login:", err);
        alert("Erro ao processar login. Contacte o suporte.");
    }
}

// Função para tratar erros (igual ao original)
export function handleLoginError(error) {
    console.error("Erro de login:", error);
    let errorText = "Erro ao fazer login. Tente novamente.";

    // Mapear códigos de erro HTTP para mensagens (similar ao Firebase)
    if (error.message) {
        switch (error.message) {
            case "Credenciais inválidas.":
            case "Senha incorreta.":
                errorText = "Senha incorreta.";
                break;
            case "Email não encontrado":
            case "Nome de usuário não encontrado":
                errorText = "Utilizador não encontrado.";
                break;
            case "Muitas tentativas falhadas.":
                errorText = "Muitas tentativas falhadas. Tente mais tarde.";
                break;
            default:
                errorText = error.message;
        }
    } else if (error.code === 401) {
        errorText = "Credenciais inválidas.";
    } else if (error.code === 500) {
        errorText = "Erro no servidor. Tente mais tarde.";
    } else if (!navigator.onLine) {
        errorText = "Estás offline. Conecta-te à internet.";
    }

    const errorMessage = document.getElementById("error-message");
    if (errorMessage) {
        errorMessage.innerText = errorText;
        errorMessage.style.color = "red";
    } else {
        alert(errorText);
    }
}
