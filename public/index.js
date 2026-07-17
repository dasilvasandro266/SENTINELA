// URL base do servidor
const API_URL = '/api';

const loginForm = document.getElementById('loginForm');
const errorMessage = document.getElementById('error-message');
const loginSubmit = document.getElementById('loginSubmit');

const isAdmin = (user) => user?.isAdmin === true || user?.isAdmin === 1 || user?.isAdmin === '1';

function setLoading(isLoading) {
  if (!loginSubmit) return;
  loginSubmit.disabled = isLoading;
  loginSubmit.textContent = isLoading ? 'A entrar...' : 'Entrar';
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const identificador = document.getElementById('identificador').value.trim();
  const password = document.getElementById('password').value;

  if (!identificador || !password) {
    errorMessage.innerText = 'Por favor, preencha todos os campos.';
    return;
  }

  if (!navigator.onLine) {
    errorMessage.innerText = 'Estás offline. Conecta-te à internet.';
    return;
  }

  try {
    errorMessage.innerText = '';
    setLoading(true);

    const response = await fetch(`${API_URL}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ identificador, password }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw { code: response.status, message: data.error };
    }

    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));
    localStorage.setItem('userUID', data.user.id);
    localStorage.setItem('userEmail', data.user.email);
    localStorage.setItem('userDisplayName', data.user.username);

    if (isAdmin(data.user)) {
      window.location.href = 'home.html';
    } else {
      window.location.href = 'home.html';
    }
  } catch (error) {
    console.error('Erro de login:', error);
    handleLoginError(error);
    setLoading(false);
  }
});

function handleLoginError(error) {
  let errorText = 'Erro ao fazer login. Tente novamente.';

  if (error.message) {
    errorText = error.message;
  } else if (error.code === 401) {
    errorText = 'Credenciais inválidas.';
  } else if (error.code === 500) {
    errorText = 'Erro no servidor. Tente mais tarde.';
  }

  errorMessage.innerText = errorText;
}

window.addEventListener('load', () => {
  const token = localStorage.getItem('token');
  if (token) {
    verifyToken(token);
  }
});

async function verifyToken(token) {
  try {
    const response = await fetch(`${API_URL}/verify-token`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (response.ok) {
      const user = JSON.parse(localStorage.getItem('user') || '{}');

      if (isAdmin(user)) {
        window.location.href = 'home.html';
      } else {
        window.location.href = 'home.html';
      }
    }
  } catch (error) {
    console.log('Token inválido ou expirado');
  }
}
