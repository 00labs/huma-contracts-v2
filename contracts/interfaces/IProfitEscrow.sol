// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

/**
 * @title IProfitEscrow
 * This contract acts as a distribution mechanism for profits generated by a pool of funds.
 * Users can deposit principal into the pool and later withdraw it, with profits generated by the pool
 * being distributed to the users proportionally based on their contributions to the total pool.
 */
interface IProfitEscrow {
    function addProfit(uint256 profit) external;

    function deposit(address account, uint256 amount) external;

    function withdraw(address account, uint256 amount) external;

    function claim(uint256 amount) external;

    function claimable(address account) external view returns (uint256);
}
