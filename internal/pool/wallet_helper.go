package pool

// WalletHelperFunctionsPlaceholder is a placeholder since we moved the functions to payout_calculator.go
// This file can be removed in the future
func WalletHelperFunctionsPlaceholder() {
	// This is just a placeholder function
}

// extractWalletFromMetadataWithFallback extracts the wallet address from worker metadata
// with fallback to a default address if not found
func extractWalletFromMetadataWithFallback(metadata map[string]interface{}, fallback string, currency string) string {
	wallet := extractWalletFromMetadataWithValidation(metadata, currency)
	if wallet == "" {
		return fallback
	}
	return wallet
}
