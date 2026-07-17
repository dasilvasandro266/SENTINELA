const API_URL = '/api';

const signupForm = document.getElementById('signupForm');
const errorMessage = document.getElementById('error-message');
const successMessage = document.getElementById('success-message');
const btnBackToLogin = document.getElementById('btnCadastrar');
const signupSubmit = document.getElementById('signupSubmit');
const aceiteTermos = document.getElementById('aceiteTermos');
const aceitePrivacidade = document.getElementById('aceitePrivacidade');
const termosModal = document.getElementById('termosModal');
const privacidadeModal = document.getElementById('privacidadeModal');
const modalOpeners = document.querySelectorAll('[data-open-modal]');
const modalClosers = document.querySelectorAll('[data-close-modal]');
const modalAccepts = document.querySelectorAll('[data-accept]');

let isSubmitting = false;

function validarEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

function validarUsername(username) {
  const re = /^[a-zA-Z0-9_]+$/;
  return re.test(username);
}

function setLoading(isLoading) {
  isSubmitting = isLoading;
  if (!signupSubmit) return;
  signupSubmit.disabled = isLoading || !isConsentValid();
  signupSubmit.textContent = isLoading ? 'A cadastrar...' : 'Cadastrar';
}

function isConsentValid() {
  return !!(aceiteTermos && aceitePrivacidade && aceiteTermos.checked && aceitePrivacidade.checked);
}

function updateConsentState() {
  if (!signupSubmit) return;
  signupSubmit.disabled = isSubmitting || !isConsentValid();
}

function toggleModal(modal, shouldOpen) {
  if (!modal) return;
  modal.classList.toggle('show', shouldOpen);
  modal.setAttribute('aria-hidden', shouldOpen ? 'false' : 'true');
}

modalOpeners.forEach((btn) => {
  btn.addEventListener('click', () => {
    const targetId = btn.getAttribute('data-open-modal');
    toggleModal(document.getElementById(targetId), true);
  });
});

modalClosers.forEach((btn) => {
  btn.addEventListener('click', () => {
    const modal = btn.closest('.legal-modal');
    toggleModal(modal, false);
  });
});

modalAccepts.forEach((btn) => {
  btn.addEventListener('click', () => {
    const tipo = btn.getAttribute('data-accept');
    if (tipo === 'termos' && aceiteTermos) aceiteTermos.checked = true;
    if (tipo === 'privacidade' && aceitePrivacidade) aceitePrivacidade.checked = true;
    updateConsentState();
    const modal = btn.closest('.legal-modal');
    toggleModal(modal, false);
  });
});

if (aceiteTermos) aceiteTermos.addEventListener('change', updateConsentState);
if (aceitePrivacidade) aceitePrivacidade.addEventListener('change', updateConsentState);

signupForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const email = document.getElementById('email').value.trim();
  const username = document.getElementById('username').value.trim();
  const nomeCompleto = document.getElementById('nomeCompleto').value.trim();
  const password = document.getElementById('password').value;
  const confirmPassword = document.getElementById('confirmPassword').value;

  errorMessage.innerText = '';
  successMessage.innerText = '';

  if (!email || !username || !password || !confirmPassword) {
    errorMessage.innerText = 'Por favor, preencha todos os campos obrigatórios.';
    return;
  }

  if (!validarEmail(email)) {
    errorMessage.innerText = 'Por favor, insira um email válido.';
    return;
  }

  if (!validarUsername(username)) {
    errorMessage.innerText = 'Nome de usuário deve conter apenas letras, números e underscore (_).';
    return;
  }

  if (username.length < 3) {
    errorMessage.innerText = 'Nome de usuário deve ter pelo menos 3 caracteres.';
    return;
  }

  if (password !== confirmPassword) {
    errorMessage.innerText = 'As senhas não coincidem.';
    return;
  }

  if (password.length < 6) {
    errorMessage.innerText = 'A senha deve ter pelo menos 6 caracteres.';
    return;
  }

  if (!navigator.onLine) {
    errorMessage.innerText = 'Estás offline. Conecta-te à internet para cadastrar.';
    return;
  }

  if (!isConsentValid()) {
    errorMessage.innerText = 'Precisas concordar com os Termos e a Política de Privacidade.';
    return;
  }

  setLoading(true);

  try {
    const response = await fetch(`${API_URL}/cadastro`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        username,
        nomeCompleto,
        password,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Erro ao cadastrar');
    }

    successMessage.innerText = 'Cadastro realizado com sucesso! Redirecionando...';

    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));
    localStorage.setItem('userUID', data.user.id);
    localStorage.setItem('userEmail', data.user.email);
    localStorage.setItem('userDisplayName', data.user.username);
    localStorage.setItem(
      'userData',
      JSON.stringify({
        nome_completo: data.user.nome_completo,
        isAdmin: data.user.isAdmin,
      })
    );

    setTimeout(() => {
      window.location.href = '/app/home';
    }, 1400);
  } catch (error) {
    console.error('Erro de cadastro:', error);
    errorMessage.innerText = error.message || 'Erro ao fazer cadastro. Tente novamente.';
    setLoading(false);
  }
});

if (btnBackToLogin) {
  btnBackToLogin.addEventListener('click', () => {
    window.location.href = '/index.html';
  });
}

document.getElementById('confirmPassword').addEventListener('input', function () {
  const password = document.getElementById('password').value;
  const confirm = this.value;

  if (confirm && password !== confirm) {
    this.style.borderColor = '#ff7b7b';
  } else {
    this.style.borderColor = '';
  }
});

document.getElementById('password').addEventListener('input', function () {
  const confirmInput = document.getElementById('confirmPassword');
  const confirm = confirmInput.value;

  if (confirm && this.value !== confirm) {
    confirmInput.style.borderColor = '#ff7b7b';
  } else if (confirm) {
    confirmInput.style.borderColor = '';
  }
});

updateConsentState();
