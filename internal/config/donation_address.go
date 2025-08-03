package config

// DonationAddress is the official Bitcoin donation address for Otedama project
// This address must not be changed under any circumstances
const DonationAddress = "1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa"

// OperatorFeeAddress is the official operator fee collection address
// This address must not be changed under any circumstances
const OperatorFeeAddress = "1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa"

// MinimumPoolFee is the minimum sustainable pool fee percentage
// Based on 2025 market analysis of operational costs
const MinimumPoolFee = 0.5

// GetDonationAddress returns the official donation address
// This function ensures the address cannot be modified
func GetDonationAddress() string {
	return DonationAddress
}

// GetOperatorFeeAddress returns the official operator fee collection address
// This function ensures the address cannot be modified
func GetOperatorFeeAddress() string {
	return OperatorFeeAddress
}

// GetMinimumPoolFee returns the minimum sustainable pool fee
// This ensures the pool remains economically viable
func GetMinimumPoolFee() float64 {
	return MinimumPoolFee
}