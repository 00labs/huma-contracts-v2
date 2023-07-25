// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

/**
 * @notice IPoolVault is the vault for a pool. It tracks the flow of underlying token.
 */

interface IPoolVault {
    /**
     * @notice Deposit underlying tokens into the pool
     * @param from the address that supplies the underlying tokens
     * @param amount amount of underlying token to deposit
     */
    function deposit(address from, uint256 amount) external;

    /**
     * @notice Withdraw underlying tokens from the pool
     * @param to the address to receive underlying tokens
     * @param amount amount of underlying token to withdraw
     */
    function withdraw(address to, uint256 amount) external;

    function addPlatformFeesReserve(uint256 reserve) external;

    function withdrawFees(address to, uint256 amount) external;

    function setRedemptionReserve(uint256 assets) external;

    /**
     * @notice get the available liquidity from this vault
     * @return the quantity of available liquidity of underlying taken
     */
    function getAvailableLiquidity() external view returns (uint256);

    function getAvailableReservation() external view returns (uint256);

    function totalAssets() external view returns (uint256);
}
