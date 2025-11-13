// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IPriceOracle
 * @notice Interface for price oracle to get PIO/USDT exchange rate
 */
interface IPriceOracle {
    /**
     * @notice Get current PIO price in USDT
     * @return price Price in 6 decimals (e.g., 1000000 = 1 USDT per PIO)
     */
    function nativePriceInUSD() external view returns (uint256 price);
}
