const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const dbPath = path.resolve(__dirname, 'sentinela.db');
const db = new sqlite3.Database(dbPath);

async function createUser() {
    const readline = require('readline').createInterface({
        input: process.stdin,
        output: process.stdout
    });

    const question = (text) => new Promise(resolve => readline.question(text, resolve));

    try {
        console.log("\n=== CRIAR NOVO USUÁRIO ===\n");
        
        const email = await question("Email: ");
        const username = await question("Nome de usuário: ");
        const nomeCompleto = await question("Nome completo: ");
        const password = await question("Senha: ");
        const isAdmin = await question("É admin? (s/n): ");

        if (!email || !username || !password) {
            console.log("❌ Email, usuário e senha são obrigatórios!");
            readline.close();
            return;
        }

        const usernameNormalized = username
            .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .replace(/\s+/g, "");

        const userId = uuidv4();
        const hashedPassword = await bcrypt.hash(password, 10);
        const adminValue = isAdmin.toLowerCase() === 's' ? 1 : 0;

        db.run(
            `INSERT INTO users (id, email, username, username_normalized, password_hash, nome_completo, isAdmin) 
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [userId, email, username, usernameNormalized, hashedPassword, nomeCompleto, adminValue],
            function(err) {
                if (err) {
                    console.error("❌ Erro ao criar usuário:", err.message);
                } else {
                    console.log("\n✅ USUÁRIO CRIADO COM SUCESSO!");
                    console.log("📧 Email:", email);
                    console.log("👤 Usuário:", username);
                    console.log("🆔 ID:", userId);
                    console.log("👑 Admin:", adminValue === 1 ? "Sim" : "Não");
                }
                readline.close();
            }
        );
    } catch (error) {
        console.error("❌ Erro:", error);
        readline.close();
    }
}

createUser();