function logDisabledFutureFlags(config, logger) {
    if (!config._logDisabledFutureFlags) {
        return;
    }
    const logFlag = (flag, message) => logger.info(`Future flag ${flag} is disabled.\n\n  ${message}\n`);
    if (!config.future?.customerAddressDefaultFix) {
        logFlag('customerAddressDefaultFix', "Enable this flag to change the CustomerAddress classes to expose a 'is_default' property instead of 'default' when fetching data.");
    }
    if (!config.future?.unstable_managedPricingSupport) {
        logFlag('unstable_managedPricingSupport', 'Enable this flag to support managed pricing, so apps can check for payments without needing a billing config. Learn more at https://shopify.dev/docs/apps/launch/billing/managed-pricing');
    }
}

export { logDisabledFutureFlags };
//# sourceMappingURL=flags.mjs.map
