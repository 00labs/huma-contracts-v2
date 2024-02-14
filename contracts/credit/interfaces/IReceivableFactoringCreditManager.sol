// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

import {ReceivableInput} from "../CreditStructs.sol";

interface IReceivableFactoringCreditManager {
    /**
     * @notice Approves the credit with the terms provided.
     * @param borrower The address of the borrower.
     * @param receivableInput The receivable input, which contains
     *   receivableAmount - The underlying token amount representing the value of the receivable.
     *   receivableId     - The NFT token ID of the receivable
     * @param creditLimit The maximum amount that can be borrowed from the credit.
     * @param remainingPeriods the number of periods before the credit expires.
     * @param yieldInBps The expected yield expressed in basis points, 1% is 100, 100% is 10000.
     * @custom:access Only the EA can call this function.
     */
    function approveReceivable(
        address borrower,
        ReceivableInput memory receivableInput,
        uint96 creditLimit,
        uint16 remainingPeriods,
        uint16 yieldInBps
    ) external;

    /**
     * @notice Updates the account and brings its billing status current.
     * @param receivableId The ID of the receivable.
     * @custom:access Anyone can call this function.
     */
    function refreshCredit(uint256 receivableId) external;

    /**
     * @notice Triggers the default process.
     * @param receivableId The ID of the receivable.
     * @return principalLoss The amount of principal loss.
     * @return yieldLoss The amount of yield loss.
     * @return feesLoss The amount of fees loss.
     * @dev It is possible for the borrower to payback even after default, especially in
     * receivable factoring cases.
     * @custom:access Only the EA can call this function
     */
    function triggerDefault(
        uint256 receivableId
    ) external returns (uint256 principalLoss, uint256 yieldLoss, uint256 feesLoss);

    /**
     * @notice Closes a credit record.
     * @param borrower The address of the borrower.
     * @param receivableId The ID of the receivable.
     * @custom:access Only the borrower or EA Service account can call this function.
     */
    function closeCredit(address borrower, uint256 receivableId) external;

    /**
     * @notice Updates the yield for the credit.
     * @param receivableId The ID of the receivable.
     * @param yieldInBps The new yield expressed in basis points.
     * @custom:access Only the EA can call this function.
     */
    function updateYield(uint256 receivableId, uint256 yieldInBps) external;

    /**
     * @notice Updates the remaining periods of the credit line
     * @param receivableId The ID of the receivable.
     * @param numOfPeriods The number of periods to add onto the credit line.
     * @custom:access Only the EA can call this function.
     */
    function extendRemainingPeriod(uint256 receivableId, uint256 numOfPeriods) external;

    /**
     * @notice Waives the late fee up to the given limit.
     * @param receivableId The ID of the receivable.
     * @param waivedAmount The amount of late fee to waive. The actual amount waived is the smaller of
     * this value and the actual amount of late fee due.
     * @custom:access Only the EA can call this function.
     */
    function waiveLateFee(
        uint256 receivableId,
        uint256 waivedAmount
    ) external returns (uint256 amountWaived);

    /**
     * @notice Checks whether the given account is a permitted payer for the credit.
     * @param account The account to check permission for.
     * @param creditHash The hash of the credit.
     * @return The address of the borrower of the credit.
     */
    function onlyPayer(address account, bytes32 creditHash) external view returns (address);
}
