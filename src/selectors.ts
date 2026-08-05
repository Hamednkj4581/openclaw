export const SIGNUP_SELECTORS = [
    "//button[@data-mobile-auth-entry-action='signup' and not(@disabled)]",
    "//button[contains(normalize-space(string(.)), 'Sign up for free') or normalize-space(string(.))='Sign up']",
    "//a[contains(@href, 'signup') and not(@aria-disabled='true')]"
];