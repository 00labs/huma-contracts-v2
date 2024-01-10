// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

/**
 * @notice IPoolFeeManager provides functions about fees.
 */
interface IPoolFeeManager {
    /**
     * @notice Distribute profit to the pool admins.
     * @param profit The total profit to be distributed including the admins and the LPs.
     * @return remaining The remaining profit after distributing to the pool admins.
     */
    function distributePoolFees(uint256 profit) external returns (uint256 remaining);

    /**
     * @notice Allows protocol owner to withdraw the protocol income.
     * @notice If the admins are required to provide first loss cover, the income for all
     * the admins including protocol owner is deposited into the loss cover. Only until
     * after the cap of the loss cover has reached, protocol owner can withdraw profit.
     * @param amount The amount to be withdrawn.
     */
    function withdrawProtocolFee(uint256 amount) external;

    /**
     * @notice Allows pool owner to withdraw the pool income.
     * @notice If the admins are required to provide first loss cover, the income for all
     * the admins including pool owner is deposited into the loss cover. Only until
     * after the cap of the loss cover has reached, the pool owner can withdraw profit.
     * @param amount The amount to be withdrawn.
     */
    function withdrawPoolOwnerFee(uint256 amount) external;

    /**
     * @notice Allows evaluation agent to withdraw the evaluation agent income.
     * @notice If the admins are required to provide first loss cover, the income for all
     * the admins including EA is deposited into the loss cover. Only until
     * after the cap of the loss cover has reached, the EA can withdraw profit.
     * @param amount The amount to be withdrawn.
     */
    function withdrawEAFee(uint256 amount) external;

    /**
     * @notice Gets the withdrawable amount for the admins (protocol, pool owner, and EA).
     * @return protocolWithdrawable Withdrawable amount for the protocol.
     * @return poolOwnerWithdrawable Withdrawable amount for the pool owner.
     * @return eaWithdrawable Withdrawable amount for the EA.
     */
    function getWithdrawables()
        external
        view
        returns (
            uint256 protocolWithdrawable,
            uint256 poolOwnerWithdrawable,
            uint256 eaWithdrawable
        );

    /**
     * @notice Returns total available incomes. PoolSafe calls this function to reserve the balance of fees.
     */
    function getTotalAvailableFees() external view returns (uint256);
}
