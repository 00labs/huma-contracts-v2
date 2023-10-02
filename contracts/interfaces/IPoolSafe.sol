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

    /**
     * @notice Reserves underlying tokens for redemption
     * @param assets the incremental number of underlying tokens to be reserved for redemption
     */
    function setRedemptionReserve(uint256 assets) external;

    /**
     * @notice Gets the available liquidity from this vault
     * @return liquidity the quantity of available liquidity of the underlying token
     */
    function getAvailableLiquidity() external view returns (uint256 liquidity);

    /**
     * @notice Gets the total assets in the pool
     * @return assets the quantity of underlying tokens in the pool
     */
    function getPoolAssets() external view returns (uint256 assets);

    // todo confirm the difference between totalAssets and getPoolAssets. We probably
    // only need one.
    function totalAssets() external view returns (uint256 assets);
}
