// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IPancakeSwapOracle
 * @notice Interface for PancakeSwap V2/V3 price oracle
 * @dev Used to fetch PIO/USDT price from PancakeSwap pair on BSC
 */
interface IPancakeSwapOracle {
    /**
     * @notice Get the current price of PIO in USDT
     * @return price Price per PIO in USDT (6 decimals precision)
     * @dev For example: if 1 PIO = 0.05 USDT, returns 50000 (0.05 * 1e6)
     */
    function getPIOPriceInUSDT() external view returns (uint256 price);

    /**
     * @notice Get the PancakeSwap pair address being used
     * @return pair The pair contract address
     */
    function getPairAddress() external view returns (address pair);

    /**
     * @notice Check if the oracle is properly initialized
     * @return initialized True if oracle is ready to use
     */
    function isInitialized() external view returns (bool initialized);
}
