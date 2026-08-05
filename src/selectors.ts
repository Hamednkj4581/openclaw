export const SIGNUP_SELECTORS = [
    "//button[@data-mobile-auth-entry-action='signup' and not(@disabled)]",
    "//button[contains(normalize-space(string(.)), 'Sign up for free') or normalize-space(string(.))='Sign up']",
    "//a[contains(@href, 'signup') and not(@aria-disabled='true')]"
];

export const MFA_CODE_SELECTORS = [
    "//input[@id='totp_otp' or @name='totp_otp']",
    "//input[@name='code' or @autocomplete='one-time-code' or @inputmode='numeric']",
    "//input[contains(translate(@placeholder, 'DIGIT', 'digit'), '6-digit code')]"
];

export const MFA_VERIFY_SELECTORS = [
    "//button[normalize-space(.)='Verify' and not(@disabled) and not(@data-visually-disabled)]",
    "//button[@type='submit' and not(@disabled) and not(@data-visually-disabled)]",
    "//button[normalize-space(.)='Continue' and not(@disabled)]"
];
