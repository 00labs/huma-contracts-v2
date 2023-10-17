// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

/**
 * @notice IPoolFeeManager provides functions about fees.
 */

interface IPoolFeeManager {
    function distributePoolFees(uint256 profit) external returns (uint256 remaining);

    /**
     * @notice Returns the remaining profit after deducting various fees
     */
    function calcPoolFeeDistribution(uint256 profit) external view returns (uint256 remaining);

    function withdrawProtocolFee(uint256 amount) external;

    function withdrawPoolOwnerFee(uint256 amount) external;

    function withdrawEAFee(uint256 amount) external;

    function getWithdrawables()
        external
        view
        returns (
            uint256 protocolWithdrawable,
            uint256 poolOwnerWithdrawable,
            uint256 eaWithdrawable
        );

    /**
     * @notice Gets total available incomes, PoolSafe uses this function to reserve the balance of fees
     */
    function getTotalAvailableFees() external view returns (uint256);
}
