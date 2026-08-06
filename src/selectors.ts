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

/** 注册弹层邮箱框：出现即表示 Sign up 已打开 */
export const SIGNUP_EMAIL_SELECTORS = [
    "//input[@id='email' or @name='email' or @type='email']"
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
