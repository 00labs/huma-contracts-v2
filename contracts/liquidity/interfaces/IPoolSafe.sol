// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

/**
 * @title IPoolSafe
 * @notice IPoolSafe defines the flow of the underlying token in and out of the pool safe
 */
interface IPoolSafe {
    /**
     * @notice Deposits underlying tokens into the pool.
     * @param from The address that supplies the underlying tokens.
     * @param amount The amount of underlying tokens to deposit.
     */
    function deposit(address from, uint256 amount) external;

    /**
     * @notice Withdraws underlying tokens from the pool.
     * @param to The address to receive underlying tokens.
     * @param amount The amount of underlying tokens to withdraw.
     */
    function withdraw(address to, uint256 amount) external;

    /**
     * @notice Reserves the unprocessed profit for junior/senior tranches.
     * @custom:access Only the Pool contract can call this function.
     * @dev A cron-like mechanism like autotask will handle it later to distribute the profit to the lenders who
     * want to receive tokens or reinvest in the pool for the lenders who want to reinvest.
     */
    function addUnprocessedProfit(address tranche, uint256 interest) external;

    /**
     * @notice Resets processed profit to 0.
     * @custom:access Only the TrancheVault contracts can call this function..
     */
    function resetUnprocessedProfit() external;

    /**
     * @notice Gets the total available underlying tokens in the pool.
     * @return availableBalance The quantity of underlying tokens in the pool.
     */
    function getAvailableBalanceForPool() external view returns (uint256 availableBalance);

    /**
     * @notice Gets the total balance of the PoolSafe.
     * @return balance The total balance in the pool safe.
     */
    function totalBalance() external view returns (uint256 balance);

    /**
     * @notice Gets the available balance of the PoolSafe that can be used to pay for admin fees.
     */
    function getAvailableBalanceForFees() external view returns (uint256 availableBalance);
}
