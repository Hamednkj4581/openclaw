export const SIGNUP_SELECTORS = [
    // 旧版 React 首页顶栏
    "//button[@data-testid='signup-button' and not(@disabled)]",
    // 新版 lightweight shell 顶栏（证据：wm-app-signupButton；同页还有隐藏卡片内的 signup 副本）
    "//button[contains(@class,'wm-app-signupButton') and not(@disabled)]",
    "//button[@data-mobile-auth-entry-action='signup' and @data-mobile-auth-entry-point='mobile_chat_stage_header' and not(@disabled)]",
    "//button[@data-mobile-auth-entry-action='signup' and not(@disabled)]",
    "//button[contains(normalize-space(string(.)), 'Sign up for free') or normalize-space(string(.))='Sign up']",
    "//a[contains(@href, 'signup') and not(@aria-disabled='true')]"
];

/** 首页 Log in 入口（与 Sign up 对称） */
export const LOGIN_SELECTORS = [
    "//button[@data-testid='login-button' and not(@disabled)]",
    "//button[contains(@class,'wm-app-loginButton') and not(@disabled)]",
    "//button[@data-mobile-auth-entry-action='login' and not(@disabled)]",
    "//button[normalize-space(string(.))='Log in']",
    "//a[contains(@href, 'login') or contains(@href, 'signin')][not(@aria-disabled='true')]"
];

/** 注册/登录弹层邮箱框（含新版 lightweight mobile-auth 弹层） */
export const SIGNUP_EMAIL_SELECTORS = [
    "//input[@id='mobile-auth-email' and not(@disabled)]",
    "//input[@id='email' or @name='email' or @type='email']"
];

/**
 * 非 OAuth 的 Continue/提交按钮。
 * 必须优先匹配邮箱表单提交，并排除 bottom-sheet 的 Close/Dismiss（它们也是 type=submit）。
 */
export const CONTINUE_SELECTORS = [
    "//form[@data-auth-provider='email']//button[@type='submit' and not(@disabled)]",
    "//button[contains(@class,'emailButton') and @type='submit' and not(@disabled)]",
    "//button[normalize-space(.)='Continue' and not(.//*[contains(translate(normalize-space(.), 'GOOGLE', 'google'), 'google')]) and not(@data-auth-provider)]",
    "//button[normalize-space(.)='Finish creating account' and not(@disabled)]",
    "//button[@data-dd-action-name='Continue' and not(@disabled)]",
    "//button[@type='submit' and not(@disabled) and not(@value='close-button') and not(@value='backdrop') and not(@data-bottom-sheet-dismiss-button) and not(@aria-label='Close') and not(@aria-label='Dismiss')]"
];

/** 已登录主界面（排除未登录 shell 上 placeholder=Ask anything 的游客 composer） */
export const AUTHENTICATED_SELECTORS = [
    "//textarea[@id='prompt-textarea' or @name='prompt-textarea']",
    "//*[@contenteditable='true' and (@id='prompt-textarea' or contains(@data-testid, 'composer'))]",
    "//button[@data-testid='accounts-profile-button']",
    "//button[contains(@aria-label, 'profile') or contains(@data-testid, 'profile')]"
];

export const MFA_CODE_SELECTORS = [
    "//input[@id='totp_otp' or @name='totp_otp']",
    "//input[@name='code' or @autocomplete='one-time-code' or @inputmode='numeric']",
    "//input[contains(translate(@placeholder, 'DIGIT', 'digit'), '6-digit code')]"
];

export const MFA_CHALLENGE_SELECTORS = [
    "//*[self::h1 or self::h2][contains(translate(normalize-space(.), 'AUTHENTICATOR', 'authenticator'), 'authenticator')]",
    "//input[@name='code' or @autocomplete='one-time-code'][ancestor::*[.//*[contains(translate(normalize-space(.), 'AUTHENTICATOR', 'authenticator'), 'authenticator')]]]",
    "//*[self::button or self::a][contains(translate(normalize-space(.), 'TRY ANOTHER METHOD', 'try another method'), 'try another method')]"
];

export const MFA_VERIFY_SELECTORS = [
    "//button[normalize-space(.)='Verify' and not(@disabled) and not(@data-visually-disabled)]",
    "//button[@type='submit' and not(@disabled) and not(@data-visually-disabled)]",
    "//button[normalize-space(.)='Continue' and not(@disabled)]"
];

export const MFA_ENABLED_SELECTORS = [
    "//button[@data-testid='mfa-authenticator-toggle' and @role='switch' and @aria-checked='true']",
    "//button[@role='switch' and @aria-checked='true' and contains(translate(@aria-label, 'AUTHENTICATOR', 'authenticator'), 'authenticator')]",
    "//*[normalize-space(.)='Authenticator app']/ancestor::*[.//button[@role='switch']][1]//button[@role='switch' and @aria-checked='true']"
];

/** ChatGPT 安全设置里短信/WhatsApp MFA 已开启 */
export const MFA_SMS_ENABLED_SELECTORS = [
    "//button[@data-testid='mfa-sms-toggle' and @role='switch' and @aria-checked='true']",
    "//button[@role='switch' and @aria-checked='true' and contains(translate(@aria-label, 'TEXT MESSAGE', 'text message'), 'text message')]",
    "//*[contains(translate(normalize-space(.), 'TEXT MESSAGE', 'text message'), 'text message') or contains(translate(normalize-space(.), 'WHATSAPP', 'whatsapp'), 'whatsapp')]/ancestor::*[.//button[@role='switch']][1]//button[@role='switch' and @aria-checked='true']"
];

/** 绑定手机号输入框 */
export const PHONE_INPUT_SELECTORS = [
    "//input[@type='tel' and not(@disabled)]",
    "//input[contains(translate(@name, 'PHONE', 'phone'), 'phone') and not(@disabled)]",
    "//input[contains(translate(@placeholder, 'PHONE', 'phone'), 'phone') and not(@disabled)]"
];

/** 发送短信验证码按钮 */
export const PHONE_SEND_CODE_SELECTORS = [
    "//button[contains(translate(normalize-space(.), 'SEND CODE', 'send code'), 'send code') and not(@disabled)]",
    "//button[contains(translate(normalize-space(.), 'CONTINUE', 'continue'), 'continue') and not(@disabled)]",
    "//button[@type='submit' and not(@disabled)]"
];
