// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

/**
 * @title IPoolSafe
 * @notice IPoolSafe defines the flow of the underlying token in and out of the pool safe
 */
interface IPoolSafe {
    /**
     * @notice Deposits underlying tokens into the pool
     * @param from the address that supplies the underlying tokens
     * @param amount amount of underlying tokens to deposit
     */
    function deposit(address from, uint256 amount) external;

    /**
     * @notice Withdraws underlying tokens from the pool
     * @param to the address to receive underlying tokens
     * @param amount amount of underlying tokens to withdraw
     */
    function withdraw(address to, uint256 amount) external;

    function totalLiquidity() external view returns (uint256 liquidity);

    function getAvailableLiquidityForFees() external view returns (uint256 liquidity);

    function getPoolLiquidity() external view returns (uint256 liquidity);

    function setRedemptionReserve(uint256 reserve) external;
}
