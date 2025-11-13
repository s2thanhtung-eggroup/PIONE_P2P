// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockPriceOracle
 * @notice Mock price oracle for testing Pione chain
 */
contract MockPriceOracle {
    uint256 private price;

    constructor(uint256 _initialPrice) {
        price = _initialPrice;
    }

    function nativePriceInUSD() external view returns (uint256) {
        return price;
    }

    function setPrice(uint256 _newPrice) external {
        price = _newPrice;
    }
}
