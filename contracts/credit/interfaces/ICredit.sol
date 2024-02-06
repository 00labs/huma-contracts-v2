// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;
import {CreditRecord, DueDetail} from "../CreditStructs.sol";

interface ICredit {
    /**
     * @notice Sets the CreditRecord associated with the creditHash.
     * @param creditHash The hash of the credit.
     * @param cr The CreditRecord to set for the creditHash.
     * @custom:access Only the CreditManager contract can call this function.
     */
    function setCreditRecord(bytes32 creditHash, CreditRecord memory cr) external;

    /**
     * @notice Sets the CreditRecord and DueDetail associated with the creditHash.
     * @param creditHash The hash of the credit.
     * @param cr The CreditRecord to set for the creditHash.
     * @param dd The DueDetail to set for the creditHash.
     * @custom:access Only the CreditManager contract can call this function.
     */
    function updateDueInfo(
        bytes32 creditHash,
        CreditRecord memory cr,
        DueDetail memory dd
    ) external;

    /**
     * @notice Returns the CreditRecord associated with the creditHash.
     * @param creditHash The hash of the credit.
     * @return The CreditRecord associated with the creditHash.
     */
    function getCreditRecord(bytes32 creditHash) external view returns (CreditRecord memory);

    /**
     * @notice Returns the DueDetail associated with the creditHash.
     * @param creditHash The hash of the credit.
     * @return The DueDetail associated with the creditHash.
     */
    function getDueDetail(bytes32 creditHash) external view returns (DueDetail memory);
}
