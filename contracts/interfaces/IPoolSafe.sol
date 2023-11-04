// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IPool} from "./IPool.sol";

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
     * @notice Gets the total available underlying tokens in the pool
     * @return liquidity the quantity of underlying tokens in the pool
     */
    function getPoolLiquidity() external view returns (uint256 liquidity);

    /**
     * @notice Gets total available balance of pool safe. Pool calls this function for profit and loss recoevery cases.
     */
    function totalLiquidity() external view returns (uint256 liquidity);

    /**
     * @notice Gets total available balance of admin fees. PoolFeeManager calls this function to
     * 1. invest in FirstLossCover if there is still room.
     * 2. withdraw by admins
     */
    function getAvailableLiquidityForFees() external view returns (uint256 liquidity);
}
