// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

/**
 * @notice IReserve maintains available underlying tokens.
 */

interface IReserve {
    /**
     * @notice Move underlying tokens from a specified address to this contract
     * @param from the address transferring underlying tokens from
     * @param amount transferred underlying token amount
     */
    function deposit(address from, uint256 amount) external;

    /**
     * @notice Move underlying tokens from this contract to a specified address
     * @param to the address transferring underlying tokens to
     * @param amount transferred underlying token amount
     */
    function withdraw(address to, uint256 amount) external;

    /**
     * @notice Return available underlying token amount
     */
    function totalAssets() external returns (uint256);
}
